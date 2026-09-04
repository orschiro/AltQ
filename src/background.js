// Chrome/Edge/Brave read `background.service_worker` and need the library
// pulled in explicitly (Firefox reads `background.scripts`, where ExtPay.js
// is already listed ahead of this file in manifest.json). importScripts is
// a no-op error in Firefox's implementation if the script is already loaded
// via background.scripts, so guard it.
if (typeof ExtPay === 'undefined' && typeof importScripts === 'function') {
	importScripts('ExtPay.js');
}

var extpay = ExtPay('alt--q-switch-recent-active-tabs');
extpay.startBackground();

// Use the native Promise-based `browser` API where available (Firefox),
// falling back to `chrome` (Chrome/Edge/Brave/etc).
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// --- Persisted state ---------------------------------------------------
// MV3 service workers (Chrome/Edge/Brave) and event pages (Firefox) can be
// terminated between events at any time — that's by design, not a bug to
// route around. Fighting it with a setInterval "keep-alive" doesn't
// actually prevent termination reliably, and every time the worker *does*
// die, any state held only in a JS variable (like the old `tabHistory`
// object) is silently lost.
//
// The real fix is to not rely on the worker staying alive: every handler
// below is stateless. It loads the recent-tabs list from
// `storage.session` (in-memory, no disk I/O, survives worker restarts,
// cleared on browser close) at the start, and saves it back at the end.
// storage.session works the same way in Chrome, Edge, Brave, and Firefox
// (115+), under the "storage" permission already in the manifest.
//
// The history is stored as a simple recency-ordered array of tab IDs
// (oldest first, most recently active last) rather than a linked list of
// object references, since object references can't round-trip through
// storage.session's structured-clone/JSON serialization.
const HISTORY_KEY = 'recentTabs';
const MAX_HISTORY = 50; // cap so it can't grow unbounded over a long session

let paid;
let defaultTabClosingBehavior = true;
let currentTabJustRemoved = false;

// --- Focused-window tracking ---------------------------------------------
// tabs.onActivated fires whenever a window's active tab changes, REGARDLESS
// of whether that window currently has OS focus. A background window can
// (and, per observed logs, does) keep changing its own active tab — e.g.
// as a side effect of our own switchTabs() calling tabs.update() on a tab
// whose window doesn't end up gaining real focus — and every one of those
// changes was being recorded as "most recent", even though the user's
// actual attention was on a completely different, already-focused window.
// That produced a feedback loop: history kept getting overwritten by a
// non-focused window's internal tab flips, switchTabs() kept acting on
// that corrupted history, targeting tabs in the wrong window, which
// produced more of the same onActivated noise.
//
// The fix is to only trust onActivated events that originate from the
// window we believe is actually focused right now. focusedWindowId is set
// from onFocusChanged (ground truth once it fires) and from the
// browserAction/shortcut handler's own tab argument (ground truth about
// what the user just interacted with), so both sources of "what's the
// real active window" agree.
let focusedWindowId = browserAPI.windows.WINDOW_ID_NONE;

async function initFocusedWindow() {
	try {
		const win = await browserAPI.windows.getLastFocused({windowTypes: ['normal']});
		if (win) {
			focusedWindowId = win.id;
		}
	} catch (err) {
		console.debug('[initFocusedWindow] failed', err);
	}
}

async function getHistory() {
	const result = await browserAPI.storage.session.get(HISTORY_KEY);
	return result[HISTORY_KEY] || [];
}

async function setHistory(history) {
	if (history.length > MAX_HISTORY) {
		history = history.slice(history.length - MAX_HISTORY);
	}
	await browserAPI.storage.session.set({[HISTORY_KEY]: history});
	validateHistory(history);
}

// --- Concurrency guard ---------------------------------------------------
// Switching windows can fire several events back to back (e.g. our own
// switchTabs() triggers both tabs.onActivated and windows.onFocusChanged
// almost simultaneously). Each of recordActiveTab/switchTabs/onRemoved does
// an async read-modify-write of the history (get, then later set). Without
// serialization, two of these can both read the same snapshot before either
// writes, and whichever write lands last silently overwrites the other's
// update — that's what produced the shuffled, seemingly-random tab order.
// Chaining every mutation through a single promise forces them to run one
// at a time, in the order they were called, eliminating that race.
let historyLock = Promise.resolve();
function withHistoryLock(fn) {
	const result = historyLock.then(fn, fn);
	historyLock = result.catch(() => {}); // never let a rejection break the chain
	return result;
}

// --- Payment status -------------------------------------------------------
// checkUser() used to be `await`ed from handleSwitchInvoked() below without
// actually returning its promise (it just fired extpay.getUser().then(...)
// and fell off the end returning undefined). That meant `await checkUser()`
// resolved instantly regardless of how long the network call to
// extensionpay.com actually took - so `paid` was effectively always one
// click stale. The real symptom this caused: if a stale/late-resolving
// check happened to land `paid = false` right as you pressed the shortcut,
// handleSwitchInvoked would skip switchTabs() entirely and call
// extpay.openPaymentPage() instead, which does two storage round-trips plus
// a live fetch() to extensionpay.com before anything visible happens - a
// multi-second hang with no tab switch, right after Chrome cold-starts the
// service worker (which is also when network stacks/DNS are coldest).
//
// Fixed properly now: checkUser() returns its promise so callers that do
// want to wait for it, can. But handleSwitchInvoked() below no longer waits
// on it at all - the switch action always acts on whatever `paid` value is
// already cached, and a fresh check is kicked off in the background,
// throttled (see maybeRefreshUser) so we're not hitting the network on
// every single press.
function checkUser() {
	return extpay.getUser().then(user => {
		paid = user.paid;
	}).catch(err => {
		console.error('Error checking user:', err);
	});
}

let userCheckInFlight = false;
let lastUserCheckStarted = 0;
const USER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // re-check payment status at most every 5 minutes

function maybeRefreshUser() {
	if (userCheckInFlight) return;
	const now = Date.now();
	if (paid !== undefined && now - lastUserCheckStarted < USER_CHECK_INTERVAL_MS) return;
	userCheckInFlight = true;
	lastUserCheckStarted = now;
	checkUser().finally(() => {
		userCheckInFlight = false;
	});
}

// Seed `paid` from whatever ExtPay already has cached in storage, without
// making a network call. This runs on every script load (including MV3
// service-worker cold starts, which happen constantly), so a fresh worker
// isn't stuck with `paid === undefined` - and therefore isn't stuck
// optimistically guessing - until a live fetch to extensionpay.com returns.
async function seedCachedPaidStatus() {
	try {
		let result;
		try {
			result = await browserAPI.storage.sync.get('extensionpay_user');
		} catch (err) {
			result = await browserAPI.storage.local.get('extensionpay_user');
		}
		const cachedUser = result && result.extensionpay_user;
		if (cachedUser && typeof cachedUser.paid === 'boolean') {
			paid = cachedUser.paid;
			console.debug('[seedCachedPaidStatus] seeded paid =', paid, 'from cache');
		}
	} catch (err) {
		console.debug('[seedCachedPaidStatus] failed', err);
	}
}

// Seed history with whatever tab is currently active, but only if we don't
// already have a history (e.g. fresh install, or first event after the
// browser starts). If the worker was just restarted mid-session,
// storage.session still has the real history, so we leave it alone.
function initHistory() {
	return withHistoryLock(async () => {
		const history = await getHistory();
		if (history.length === 0) {
			const tabs = await browserAPI.tabs.query({active: true, lastFocusedWindow: true});
			if (tabs && tabs[0]) {
				await setHistory([tabs[0].id]);
			}
		}
	});
}

// --- Focus-event reconciliation -----------------------------------------
// Firefox's windows.onFocusChanged is supposed to fire WINDOW_ID_NONE (-1)
// when a window loses browser focus, followed by a second event carrying
// the real window ID once a (possibly different) window gains focus. In
// practice that second event is not reliably delivered on every platform
// (observed dropping out especially around fast focus switches / certain
// window managers on Linux). When it's dropped, our history never learns
// that a tab in the newly-focused window became active, so it stays
// pointing at stale state from the previously-focused window — which is
// why the shortcut can appear to only toggle between tabs in one window
// and never jump to the other window that currently has actual focus.
//
// Rather than trying to force that missing event to fire, we reconcile
// against ground truth (tabs.query) immediately before acting on the
// shortcut, so a dropped focus event can't leave switchTabs() working off
// out-of-date history. This is a plain call into the existing
// recordActiveTab() logic (itself lock-protected and already a no-op if
// the queried tab is already the most recent entry), so it's safe to run
// unconditionally on every click/shortcut press.
async function syncCurrentActiveTab() {
	const tabs = await browserAPI.tabs.query({active: true, lastFocusedWindow: true});
	if (tabs && tabs[0]) {
		await recordActiveTab(tabs[0].id);
	}
}

function switchTabs() {
	return withHistoryLock(async () => {
		const history = await getHistory();
		console.debug('[switchTabs] history =', history.join(' => '));
		if (history.length < 2) {
			console.debug('[switchTabs] not enough history, no-op');
			return; // No previous tab recorded yet.
		}
		const prevTabId = history[history.length - 2];
		console.debug('[switchTabs] targeting prevTabId =', prevTabId);
		try {
			const updatedTab = await browserAPI.tabs.update(prevTabId, {active: true});
			if (updatedTab && updatedTab.windowId != null) {
				console.debug('[switchTabs] activated tab', prevTabId, 'in window', updatedTab.windowId, '- focusing window');
				await browserAPI.windows.update(updatedTab.windowId, {focused: true});
			} else {
				console.error('tabs.update did not return an updated tab; cannot focus window');
			}
		} catch (err) {
			// Tab was probably closed without onRemoved having run yet (or we
			// raced with something else). Drop the stale id so the next press
			// falls through to the next candidate instead of failing again.
			console.error('Error switching tabs:', err);
			await setHistory(history.filter(id => id !== prevTabId));
		}
	});
}

// Check whether new browser version is installed
browserAPI.runtime.onInstalled.addListener(function(details){
	if(details.reason == "install"){
		extpay.openPaymentPage();
	} else if(details.reason == "update"){
		seedCachedPaidStatus().then(checkUser);
	}
	initHistory();
	initFocusedWindow();
});

// On browser start
browserAPI.runtime.onStartup.addListener(function() {
	seedCachedPaidStatus().then(checkUser);
	initHistory();
	initFocusedWindow();
});

// Shared logic for "the user invoked the switch action", regardless of
// whether it came from clicking the toolbar icon (browserAction/action
// .onClicked) or a keyboard shortcut (commands.onCommand). Manifest V3 (and
// V2) only routes a keyboard shortcut to onClicked automatically if the
// manifest's commands entry uses the reserved name "_execute_action" (or
// "_execute_browser_action" in MV2) — a custom command name instead fires
// commands.onCommand, which nothing was listening to. If that's the case
// here, the keyboard shortcut would silently do nothing at all while
// clicking the toolbar icon still worked, which looks exactly like
// "only switches within whichever window I click the icon from".
async function handleSwitchInvoked(source, tab) {
	console.debug('[handleSwitchInvoked] source =', source, 'tab =', tab && tab.id, 'window =', tab && tab.windowId);
	// Kick off a payment-status refresh in the background (throttled - see
	// maybeRefreshUser) instead of waiting on it. Whatever `paid` already
	// holds (seeded from cache at startup, or from the last completed
	// check) is what this invocation acts on, so the shortcut/click always
	// responds immediately regardless of extensionpay.com's response time.
	maybeRefreshUser();

	if (tab && tab.windowId != null) {
		focusedWindowId = tab.windowId;
	}
	await syncCurrentActiveTab();

	if (paid === false) {
		extpay.openPaymentPage();
	}
	else {
		// paid === true, or paid === undefined (not known yet - e.g. very
		// first run before the initial check has returned). Optimistically
		// allow the switch: worst case a not-yet-paid user gets one or two
		// free switches before the real status comes back, which is a far
		// better failure mode than the shortcut silently hanging.
		await switchTabs();
	}
}

// on click or shortcut
// Funktioniert in Firefox und Chrome:
(browserAPI.browserAction || browserAPI.action).onClicked.addListener(async function(tab) {
	await handleSwitchInvoked('onClicked', tab);
});

// Keyboard shortcut, in case the manifest's commands entry uses a custom
// command name rather than the reserved "_execute_action"/
// "_execute_browser_action" (which would route through onClicked above
// instead, and this listener simply won't fire in that case — that's fine,
// both are covered now).
if (browserAPI.commands && browserAPI.commands.onCommand) {
	browserAPI.commands.onCommand.addListener(async function(command) {
		console.debug('[commands.onCommand]', command);
		const tabs = await browserAPI.tabs.query({active: true, lastFocusedWindow: true});
		await handleSwitchInvoked('onCommand:' + command, tabs && tabs[0]);
	});
}

// Core "a tab became the active one" logic, shared by browserAPI.tabs.onActivated
// and browserAPI.windows.onFocusChanged (see below for why both are needed).
function recordActiveTab(tabId) {
	return withHistoryLock(async () => {
		// After the current tab is closed, this can fire again as part of
		// Chrome/Firefox switching to their own default tab first. Skip that
		// one so it doesn't get recorded ahead of the tab we actually want.
		if (currentTabJustRemoved) {
			currentTabJustRemoved = false;
			console.debug('[recordActiveTab] skipped (currentTabJustRemoved)', tabId);
			return;
		}

		let history = await getHistory();
		if (history[history.length - 1] === tabId) {
			console.debug('[recordActiveTab] no-op, already most recent', tabId);
			return; // Already the most recent; nothing to do.
		}
		history = history.filter(id => id !== tabId); // Drop any earlier occurrence.
		history.push(tabId);
		console.debug('[recordActiveTab] recording', tabId);
		await setHistory(history);
	});
}

browserAPI.tabs.onActivated.addListener(function(info) {
	console.debug('[onActivated]', info);
	// Ignore tab activations happening in a window we don't believe has
	// real focus right now (see the focusedWindowId comment above). A
	// background window changing its own active tab is not the user
	// looking at something new, and recording it as "most recent" is what
	// caused history to get overwritten by a non-focused window's internal
	// tab flips.
	if (focusedWindowId !== browserAPI.windows.WINDOW_ID_NONE && info.windowId !== focusedWindowId) {
		console.debug('[onActivated] ignoring, window', info.windowId, 'is not the focused window', focusedWindowId);
		return;
	}
	recordActiveTab(info.tabId);
});

// browserAPI.tabs.onActivated only fires when the *active tab within a window*
// changes. It does NOT fire when you switch focus to a different window
// whose active tab hasn't changed (e.g. alt-tabbing back to a window you'd
// left on the same tab), and it's not a reliable signal for a brand-new
// window's default tab becoming active either. Without this listener, the
// extension's notion of "current tab" gets stuck pointing at a tab in a
// window you've since left, which is why switching between windows didn't
// work: pressing the shortcut acted on stale state instead of the tab you
// were actually just looking at.
//
// Note: this listener alone is not fully reliable either — see
// syncCurrentActiveTab() above for the case where Firefox drops the
// "gained focus" event entirely and this listener never fires at all.
browserAPI.windows.onFocusChanged.addListener(async function(windowId) {
	console.debug('[onFocusChanged]', windowId);
	if (windowId === browserAPI.windows.WINDOW_ID_NONE) {
		// Chrome/Firefox itself lost focus (e.g. switched to another app).
		// Nothing to record until a browser window is focused again.
		return;
	}

	// Not every windowId that can gain OS focus is a normal tabbed browser
	// window: undocked DevTools, extension popups, and Firefox's
	// Picture-in-Picture player are all separate top-level windows with
	// their own windowId but zero tabs. tabs.query({windowId}) correctly
	// returns nothing for these, which is why the old code silently did
	// nothing — but that also meant we had no visibility into *why*, which
	// made it look like a real window switch was being missed. Checking
	// windows.get() up front lets us log the actual window type so this is
	// diagnosable, and skip non-"normal" windows explicitly rather than
	// relying on tabs.query returning empty as an implicit signal.
	let win;
	try {
		win = await browserAPI.windows.get(windowId);
	} catch (err) {
		console.debug('[onFocusChanged] windows.get failed for', windowId, err);
		return;
	}

	if (win.type !== 'normal') {
		console.debug('[onFocusChanged] skipping non-normal window', windowId, 'type =', win.type);
		return;
	}

	// Update ground truth first, before the (async) tabs.query below
	// resolves, so any onActivated events that arrive in the meantime are
	// judged against the window the user is actually now looking at.
	focusedWindowId = windowId;

	browserAPI.tabs.query({active: true, windowId: windowId}, function(tabs) {
		console.debug('[onFocusChanged] active tab in window', windowId, '=>', tabs && tabs[0] && tabs[0].id);
		if (tabs && tabs[0]) {
			recordActiveTab(tabs[0].id);
		} else {
			// A normal window with no queryable active tab is unexpected
			// (as opposed to a devtools/popup window, which is normal to
			// skip above). This can happen if the window is still being
			// created — retry once on the next tick rather than losing
			// the event outright.
			setTimeout(async () => {
				const retryTabs = await browserAPI.tabs.query({active: true, windowId: windowId});
				console.debug('[onFocusChanged] retry active tab in window', windowId, '=>', retryTabs && retryTabs[0] && retryTabs[0].id);
				if (retryTabs && retryTabs[0]) {
					recordActiveTab(retryTabs[0].id);
				}
			}, 50);
		}
	});
});

browserAPI.tabs.onRemoved.addListener(function(tabId, info) {
	withHistoryLock(async () => {
		let history = await getHistory();
		const wasCurrent = history[history.length - 1] === tabId;
		history = history.filter(id => id !== tabId);
		await setHistory(history);

		if (wasCurrent && !defaultTabClosingBehavior && history.length > 0) {
			const newCurrentId = history[history.length - 1];
			currentTabJustRemoved = true;
			try {
				await browserAPI.tabs.update(newCurrentId, {active: true});
			} catch (err) {
				// Target tab is gone too (e.g. closing a whole window); nothing
				// to switch to, so don't leave the flag set for a future event.
				currentTabJustRemoved = false;
			}
		}
	});
});

function validateHistory(history) {
	console.debug(history.join(' => '));
}

// Initialize on script load. This also covers the worker being restarted
// mid-session (e.g. after Chrome's idle timeout): initHistory() is a no-op
// if storage.session already has data, so nothing is lost. seedCachedPaidStatus()
// gives `paid` a same-tick, network-free value on every one of these cold
// starts so handleSwitchInvoked() is never left guessing with `undefined`.
seedCachedPaidStatus();
initHistory();
initFocusedWindow();