const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const FALLBACK_MATCHES = ['<all_urls>'];

const toggle = document.getElementById('fallback-toggle');
const status = document.getElementById('status');

function setStatus(text, kind) {
	status.textContent = text;
	status.className = kind || '';
}

// permissions.request()/remove() must be called from a script running in
// an extension page with an active user gesture (this click handler) -
// the background script has no such gesture to call it with, which is why
// this logic lives here rather than being triggered by a message alone.
// After the grant/revoke succeeds, background.js is told to bring the
// actual chrome.scripting registration in line with the new state (see
// the 'sync-fallback-content-script' handler in background.js).
async function setEnabled(enabled) {
	toggle.disabled = true;
	setStatus('Updating…');
	try {
		let ok;
		if (enabled) {
			ok = await browserAPI.permissions.request({origins: FALLBACK_MATCHES});
		} else {
			ok = await browserAPI.permissions.remove({origins: FALLBACK_MATCHES});
		}

		if (!ok) {
			// User dismissed the browser's own permission prompt (for the
			// "request" case) - not an error, just not granted. Reflect
			// the real (unchanged) state rather than the toggle's now-wrong
			// position.
			toggle.checked = !enabled;
			setStatus(enabled ? 'Permission not granted.' : '', enabled ? 'error' : '');
			return;
		}

		const response = await browserAPI.runtime.sendMessage({type: 'sync-fallback-content-script'});
		// If the background script didn't answer (asleep/restarting, or an
		// older build that returned a Promise Chrome drops), don't assume
		// "off" - ask the browser what the permission state actually is.
		if (response && typeof response.granted === 'boolean') {
			toggle.checked = response.granted;
		} else {
			toggle.checked = await browserAPI.permissions.contains({origins: FALLBACK_MATCHES});
		}
		setStatus(toggle.checked ? 'Enabled.' : 'Disabled.', 'ok');
	} catch (err) {
		console.error('[options] setEnabled failed', err);
		setStatus('Something went wrong — please try again.', 'error');
		// Reload the real state rather than trusting the toggle's current
		// (possibly now-wrong) position.
		await refreshState();
	} finally {
		toggle.disabled = false;
	}
}

async function refreshState() {
	try {
		const granted = await browserAPI.permissions.contains({origins: FALLBACK_MATCHES});
		toggle.checked = granted;
		setStatus('');
	} catch (err) {
		console.error('[options] refreshState failed', err);
		setStatus('Could not read current setting.', 'error');
	}
}

toggle.addEventListener('change', () => {
	setEnabled(toggle.checked);
});

// --- Keyboard shortcut ---------------------------------------------------
// Firefox lets an extension change its own shortcuts via commands.update()
// / commands.reset(), so there the "Change…" button records a key
// combination right on this page. Chrome (and other Chromium browsers)
// have no such API - shortcuts can only be edited on the browser's own
// page - so there the button opens that page instead
// (commands.openShortcutSettings()) and the options page just shows the
// current shortcut.
const DEFAULT_SHORTCUT = 'Alt+Q';
const IS_MAC = /Mac/i.test(navigator.userAgent);
const canUpdateShortcut = !!(browserAPI.commands && typeof browserAPI.commands.update === 'function');

const shortcutDisplay = document.getElementById('shortcut-display');
const shortcutButton = document.getElementById('shortcut-button');
const shortcutReset = document.getElementById('shortcut-reset');
const shortcutHelp = document.getElementById('shortcut-help');
const shortcutStatus = document.getElementById('shortcut-status');

const HELP_IDLE = canUpdateShortcut
	? 'Click “Change…”, then press the new key combination.'
	: 'Browsers like Chrome don’t let extensions change their own shortcut, so “Change…” opens the browser’s shortcut settings, where you can change or remove it.';
const HELP_CAPTURING = 'Press the new key combination now. Esc cancels, Backspace removes the shortcut.';

let actionCommandName = '_execute_action';
let capturing = false;

function setShortcutStatus(text, kind) {
	shortcutStatus.textContent = text || '';
	shortcutStatus.className = kind || '';
}

async function getActionCommand() {
	if (!browserAPI.commands || !browserAPI.commands.getAll) {
		return null;
	}
	const commands = await browserAPI.commands.getAll();
	return commands.find(c => c.name === '_execute_action' || c.name === '_execute_browser_action') || null;
}

async function renderShortcut() {
	let cmd = null;
	try {
		cmd = await getActionCommand();
	} catch (err) {
		console.debug('[options] commands.getAll failed', err);
	}
	if (cmd) {
		actionCommandName = cmd.name;
	}
	const shortcut = cmd ? cmd.shortcut : DEFAULT_SHORTCUT;
	shortcutDisplay.textContent = shortcut || 'Not set';
	shortcutDisplay.classList.toggle('unset', !shortcut);
	shortcutDisplay.classList.remove('capturing');
	shortcutReset.hidden = !canUpdateShortcut || shortcut === DEFAULT_SHORTCUT;
	shortcutHelp.textContent = HELP_IDLE;
}

// KeyboardEvent.code -> key name accepted by commands.update().
function codeToKeyName(code) {
	let m;
	if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
	if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
	if (/^F([1-9]|1[0-2])$/.test(code)) return code;
	const map = {
		Comma: 'Comma', Period: 'Period', Home: 'Home', End: 'End',
		PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space',
		Insert: 'Insert', Delete: 'Delete',
		ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
	};
	return map[code] || null;
}

// Modifier names in the order commands.update() expects: the primary
// modifier(s) first, Shift last.
function modifiersFromEvent(e) {
	const mods = [];
	if (e.ctrlKey) mods.push(IS_MAC ? 'MacCtrl' : 'Ctrl');
	if (e.metaKey && IS_MAC) mods.push('Command');
	if (e.altKey) mods.push('Alt');
	if (e.shiftKey) mods.push('Shift');
	return mods;
}

function onCaptureKeyDown(e) {
	// Swallow everything while recording, so the combination being pressed
	// doesn't also trigger the page or the browser.
	e.preventDefault();
	e.stopPropagation();
	if (e.repeat) {
		return;
	}

	const anyModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
	if (!anyModifier && e.key === 'Escape') {
		stopCapture();
		setShortcutStatus('');
		return;
	}
	if (!anyModifier && e.key === 'Backspace') {
		applyShortcut('');
		return;
	}

	// Just a modifier going down: show it as a live preview and wait for the
	// actual key.
	if (['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS'].includes(e.key)) {
		const mods = modifiersFromEvent(e);
		shortcutDisplay.textContent = mods.length ? mods.join('+') + '+…' : 'Press keys…';
		return;
	}

	const key = codeToKeyName(e.code);
	if (!key) {
		setShortcutStatus('That key can’t be used in a shortcut. Try a letter, number, or F-key.', 'error');
		return;
	}
	if (e.metaKey && !IS_MAC) {
		setShortcutStatus('The Windows/Super key can’t be used. Use Ctrl or Alt instead.', 'error');
		return;
	}

	const mods = modifiersFromEvent(e);
	const isFunctionKey = /^F\d+$/.test(key);
	const hasPrimaryModifier = mods.some(m => m !== 'Shift');
	if (!hasPrimaryModifier && !isFunctionKey) {
		setShortcutStatus(
			IS_MAC ? 'Include Command, Control or Option in the shortcut.' : 'Include Ctrl or Alt in the shortcut.',
			'error');
		return;
	}
	if (mods.length > 2) {
		setShortcutStatus('Use at most two modifier keys (e.g. Ctrl+Shift).', 'error');
		return;
	}

	applyShortcut(mods.concat(key).join('+'));
}

function onCaptureBlur() {
	// The user clicked away or switched windows - don't leave a recorder
	// armed that will grab the next key they press.
	stopCapture();
}

function startCapture() {
	capturing = true;
	setShortcutStatus('');
	shortcutButton.textContent = 'Cancel';
	shortcutButton.blur(); // so Space/Enter can't re-click the button
	shortcutDisplay.textContent = 'Press keys…';
	shortcutDisplay.classList.remove('unset');
	shortcutDisplay.classList.add('capturing');
	shortcutHelp.textContent = HELP_CAPTURING;
	document.addEventListener('keydown', onCaptureKeyDown, true);
	window.addEventListener('blur', onCaptureBlur);
}

function stopCapture() {
	if (!capturing) {
		return;
	}
	capturing = false;
	document.removeEventListener('keydown', onCaptureKeyDown, true);
	window.removeEventListener('blur', onCaptureBlur);
	shortcutButton.textContent = 'Change…';
	renderShortcut();
}

// shortcut === '' removes the shortcut.
async function applyShortcut(shortcut) {
	stopCapture();
	try {
		await browserAPI.commands.update({name: actionCommandName, shortcut: shortcut});
		await notifyShortcutChanged();
		await renderShortcut();
		setShortcutStatus(shortcut ? 'Shortcut changed to ' + shortcut + '.' : 'Shortcut removed.', 'ok');
	} catch (err) {
		console.error('[options] commands.update failed', err);
		await renderShortcut();
		setShortcutStatus('The browser rejected that shortcut' + (err && err.message ? ' (' + err.message + ')' : '') + '. Try a different combination.', 'error');
	}
}

async function resetShortcut() {
	try {
		await browserAPI.commands.reset(actionCommandName);
		await notifyShortcutChanged();
		await renderShortcut();
		setShortcutStatus('Shortcut reset to ' + DEFAULT_SHORTCUT + '.', 'ok');
	} catch (err) {
		console.error('[options] commands.reset failed', err);
		setShortcutStatus('Could not reset the shortcut.', 'error');
	}
}

// Lets background.js refresh the binding that the "work on every website"
// content script matches against (see syncShortcutBinding in background.js).
async function notifyShortcutChanged() {
	try {
		await browserAPI.runtime.sendMessage({type: 'sync-shortcut-binding'});
	} catch (err) {
		console.debug('[options] sync-shortcut-binding not acknowledged', err);
	}
}

shortcutButton.addEventListener('click', () => {
	if (canUpdateShortcut) {
		if (capturing) {
			stopCapture();
			setShortcutStatus('');
		} else {
			startCapture();
		}
		return;
	}
	// No direct way to change it (Chrome etc.): open the browser's own
	// shortcut page, scrolled to this extension where supported.
	if (browserAPI.commands && browserAPI.commands.openShortcutSettings) {
		browserAPI.commands.openShortcutSettings().catch(err => {
			console.debug('[options] openShortcutSettings failed', err);
			setShortcutStatus('Open chrome://extensions/shortcuts in a new tab to change the shortcut.', 'error');
		});
	} else {
		// chrome:// pages can't be opened from extension code, so tell the
		// user where to go.
		setShortcutStatus('Open chrome://extensions/shortcuts (or your browser’s extension settings) in a new tab to change the shortcut.', 'error');
	}
});

shortcutReset.addEventListener('click', resetShortcut);

// Pick up changes made elsewhere (e.g. in the browser's own shortcut
// settings) when the user comes back to this tab.
window.addEventListener('focus', () => {
	if (!capturing) {
		renderShortcut();
	}
});

renderShortcut();
refreshState();
