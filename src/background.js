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

// ExtPay fires this the moment a payment is confirmed, independent of any
// polling. Without this listener, the only way `paid` ever gets set is
// checkUser() (via maybeRefreshUser(), throttled and never awaited) or
// seedCachedPaidStatus() re-reading whatever was last cached - both of
// which can easily miss the actual login/payment moment on MV3, since the
// service worker is free to be killed seconds after the payment tab opens
// and isn't guaranteed to be alive again when the payment completes. That
// produces exactly the symptom of "logged in, but the extension keeps
// treating me as unpaid": a single stale `paid = false`, cached from a
// check that ran before payment went through, then keeps getting re-seeded
// from storage on every subsequent cold start, with nothing to ever
// overwrite it with the truth. Listening for onPaid gives us a direct,
// authoritative signal the instant it happens, instead of relying on that
// polling to eventually line up.
//
// `lastUserCheckStarted` is also updated here, so this counts as
// equivalent to a fresh checkUser() completing - otherwise maybeRefreshUser
// would see `paid` freshly flip to true but `lastUserCheckStarted` still
// at its old value, and could fire an immediate, redundant network check
// on the very next press.
extpay.onPaid.addListener(function(user) {
	console.debug('[extpay.onPaid] payment confirmed, paid = true');
	paid = true;
	lastUserCheckStarted = Date.now();
});

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
	// Only throttle while we currently believe the user IS paid - that's the
	// low-stakes direction to be wrong in (worst case: a lapsed subscription
	// stays treated as paid for a few extra minutes). `paid === false` (or
	// still undefined, e.g. very first run) always gets a fresh check on
	// every press instead: being wrong in that direction means every press
	// keeps hitting the `paid === false` branch and reopening the
	// payment/billing page even after the person has actually paid, which is
	// the far worse failure mode and exactly what caused this bug.
	if (paid === true && now - lastUserCheckStarted < USER_CHECK_INTERVAL_MS) return;
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

// --- Alt+Q fallback content script (optional, permission-gated) ---------
// content-script.js is no longer declared statically in manifest.json's
// content_scripts with <all_urls> - Chrome Web Store review flags that as
// "broad host permissions" and delays publishing, since it grants the
// extension access to every page unconditionally at install time. Instead,
// "<all_urls>" is listed under optional_host_permissions, and the content
// script is registered dynamically via chrome.scripting only once the user
// has explicitly granted that permission from the options page (see
// options.js). Nothing here changes what the content script itself does or
// why it's needed (see content-script.js for that) - this only changes
// *when* it's allowed to run: opt-in instead of on by default.
const FALLBACK_SCRIPT_ID = 'altq-fallback';
const FALLBACK_MATCHES = ['<all_urls>'];

async function hasFallbackPermission() {
	try {
		return await browserAPI.permissions.contains({origins: FALLBACK_MATCHES});
	} catch (err) {
		console.debug('[hasFallbackPermission] failed', err);
		return false;
	}
}

// Makes the actual chrome.scripting registration match whatever permission
// state currently holds. Safe to call at any time (on startup, after the
// user toggles the option, after a permission gets revoked from
// chrome://extensions) - it's idempotent, checking current registration
// state before acting rather than assuming.
async function syncFallbackContentScript() {
	if (!browserAPI.scripting || !browserAPI.scripting.registerContentScripts) {
		// Older Firefox versions don't have chrome.scripting.
		// registerContentScripts (added in Firefox 102). Nothing we can do
		// here without it; the fallback just stays unavailable there.
		console.debug('[syncFallbackContentScript] scripting.registerContentScripts unavailable');
		return false;
	}

	const granted = await hasFallbackPermission();

	let existing = [];
	try {
		existing = await browserAPI.scripting.getRegisteredContentScripts({ids: [FALLBACK_SCRIPT_ID]});
	} catch (err) {
		console.debug('[syncFallbackContentScript] getRegisteredContentScripts failed', err);
	}
	const isRegistered = existing.length > 0;

	if (granted && !isRegistered) {
		try {
			await browserAPI.scripting.registerContentScripts([{
				id: FALLBACK_SCRIPT_ID,
				matches: FALLBACK_MATCHES,
				js: ['content-script.js'],
				runAt: 'document_start',
				allFrames: true,
				persistAcrossSessions: true
			}]);
			console.debug('[syncFallbackContentScript] registered');
		} catch (err) {
			console.error('[syncFallbackContentScript] registration failed', err);
		}
		// registerContentScripts() only affects pages that load/navigate from
		// this point on - it does nothing for tabs that were already open
		// before the permission was granted (e.g. the exact GitLab tab
		// someone enabled this setting to fix). Without this, the first
		// thing a person does after flipping the toggle on is retest in that
		// same tab and see it still fail, with no indication that a reload
		// would have fixed it. Push the script into every currently-open,
		// injectable tab right now so the fix is immediate.
		await injectFallbackIntoOpenTabs();
	} else if (!granted && isRegistered) {
		try {
			await browserAPI.scripting.unregisterContentScripts({ids: [FALLBACK_SCRIPT_ID]});
			console.debug('[syncFallbackContentScript] unregistered (permission revoked)');
		} catch (err) {
			console.error('[syncFallbackContentScript] unregistration failed', err);
		}
	}

	return granted;
}

// One-time catch-up injection for tabs that predate the permission grant
// (see the call site above). Uses executeScript rather than
// registerContentScripts because this needs to happen *once, right now* for
// tabs that already have a document loaded - registerContentScripts only
// ever fires on a future navigation. Every tab is attempted independently
// and failures are swallowed per-tab: plenty of open tabs are legitimately
// off-limits (chrome://, about:, the Chrome Web Store, other extensions'
// pages, PDF viewers) and executeScript rejecting for those is expected,
// not a bug - it shouldn't stop the script from reaching the tabs that
// *can* take it.
async function injectFallbackIntoOpenTabs() {
	if (!browserAPI.scripting || !browserAPI.scripting.executeScript) {
		return;
	}
	let tabs = [];
	try {
		tabs = await browserAPI.tabs.query({url: ['http://*/*', 'https://*/*']});
	} catch (err) {
		console.debug('[injectFallbackIntoOpenTabs] tabs.query failed', err);
		return;
	}
	await Promise.all(tabs.map(async tab => {
		try {
			await browserAPI.scripting.executeScript({
				target: {tabId: tab.id, allFrames: true},
				files: ['content-script.js']
			});
		} catch (err) {
			// Expected for restricted pages, or a tab that's mid-navigation -
			// nothing actionable to do per-tab here.
			console.debug('[injectFallbackIntoOpenTabs] skipped tab', tab.id, err);
		}
	}));
}

// The user (or Chrome itself, e.g. on a permissions-review prompt) can
// revoke the <all_urls> grant at any time from chrome://extensions without
// going through options.js at all. chrome.scripting registrations don't
// automatically unregister themselves when that happens, so without this
// listener the extension would keep trying to inject a script it no longer
// has permission for (a silent, permanent no-op - not a crash, but the
// fallback would appear "on" in the options page's cached state while
// actually doing nothing). Reacting to onRemoved/onAdded keeps the actual
// registration and the true permission state from drifting apart.
if (browserAPI.permissions && browserAPI.permissions.onRemoved) {
	browserAPI.permissions.onRemoved.addListener(function(permissions) {
		if (permissions.origins && permissions.origins.includes('<all_urls>')) {
			syncFallbackContentScript();
		}
	});
}
if (browserAPI.permissions && browserAPI.permissions.onAdded) {
	browserAPI.permissions.onAdded.addListener(function(permissions) {
		if (permissions.origins && permissions.origins.includes('<all_urls>')) {
			syncFallbackContentScript();
		}
	});
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
	syncFallbackContentScript();
});

// On browser start
browserAPI.runtime.onStartup.addListener(function() {
	seedCachedPaidStatus().then(checkUser);
	initHistory();
	initFocusedWindow();
	syncFallbackContentScript();
});

// Shared logic for "the user invoked the switch action", regardless of
// whether it came from clicking the toolbar icon (browserAction/action
// .onClicked), a keyboard shortcut (commands.onCommand), or the content
// script's own Alt+Q capture (runtime.onMessage - see below for why that
// third path exists). Manifest V3 (and V2) only routes a keyboard shortcut
// to onClicked automatically if the manifest's commands entry uses the
// reserved name "_execute_action" (or "_execute_browser_action" in MV2) —
// a custom command name instead fires commands.onCommand, which nothing
// was listening to. If that's the case here, the keyboard shortcut would
// silently do nothing at all while clicking the toolbar icon still worked,
// which looks exactly like "only switches within whichever window I click
// the icon from".
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
		// `paid` being false here might not be current. It could be a value
		// re-seeded from a stale storage.sync/local cache after an MV3
		// service-worker restart, or the result of an earlier checkUser()
		// call that happened to run before ExtPay/Stripe finished processing
		// a just-completed payment. Since the consequence of trusting a
		// stale false is repeatedly sending an already-paid user to
		// checkout/billing instead of switching tabs, do one fresh, awaited
		// check right before acting on it - unlike maybeRefreshUser() above,
		// this one is awaited, so it can't be cut short by the service
		// worker being reaped before it resolves the way a fire-and-forget
		// checkUser() call could be.
		await checkUser();
	}

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

// Fallback path for pages that swallow the Alt+Q keydown themselves.
//
// Firefox's `commands` shortcuts are only reserved/uncancellable for a
// small built-in list (Ctrl+T, Ctrl+W, etc). For everything else, including
// Alt+Q, the keydown reaches page content first, and if the page's own JS
// calls event.preventDefault() on it, Firefox drops the extension shortcut
// silently - commands.onCommand above never fires at all, with nothing
// logged and no error. This was observed on pages with their own
// keyboard-driven overlays (e.g. GitLab's enlarged-image lightbox), which
// bind their own keydown handling while open and preventDefault() broadly.
//
// content-script.js runs on every page (see manifest.json) and installs a
// capture-phase keydown listener early enough (document_start) to catch
// Alt+Q ahead of the page's own handler and call
// stopImmediatePropagation() itself, then relays it here via sendMessage.
// This listener reuses the exact same handleSwitchInvoked() path as the
// other two triggers, so history-recording, the payment check, and the
// actual tab switch all behave identically regardless of which of the
// three paths fired.
browserAPI.runtime.onMessage.addListener(function(message, sender) {
	if (!message || message.type !== 'switch-tabs') {
		return;
	}
	console.debug('[runtime.onMessage] switch-tabs from tab', sender.tab && sender.tab.id);
	// Returning the promise (rather than using it fire-and-forget) lets the
	// sendMessage() call in content-script.js resolve once this has
	// actually finished, and lets Chrome/Firefox know to keep the message
	// channel open until it does.
	return handleSwitchInvoked('contentScript', sender.tab);
});

// options.js requests browserAPI.permissions.request()/remove() itself
// (that call has to originate from a page with its own user-gesture
// context, which the background script doesn't have) and then sends this
// message afterwards so the actual chrome.scripting registration gets
// brought in line with whatever the new permission state is. It also
// doubles as a "what's the current state" query when options.html first
// loads, so the toggle can reflect reality instead of assuming.
browserAPI.runtime.onMessage.addListener(function(message) {
	if (!message || message.type !== 'sync-fallback-content-script') {
		return;
	}
	return syncFallbackContentScript().then(granted => ({granted}));
});

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