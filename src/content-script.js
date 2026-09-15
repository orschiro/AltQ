// Fallback path for the Alt+Q shortcut.
//
// Firefox's `commands` API shortcuts are not privileged for arbitrary
// combos (only a small reserved list like Ctrl+T/Ctrl+W is protected). For
// everything else - including Alt+Q - the keydown is delivered to the page
// first, and if the page's own JS calls event.preventDefault() on it,
// Firefox drops the extension shortcut silently: commands.onCommand simply
// never fires. This has been observed on pages that have their own
// keyboard-driven overlays (e.g. GitLab's image lightbox), which listen for
// keys like Escape/arrows/etc. and preventDefault() broadly while open.
//
// background.js can't see or work around this at all, since it never
// receives the event in the first place. The only place this can be fixed
// is in the page itself, by getting our own listener in ahead of the
// page's. Two things make that reliable:
//   1. This script is injected at document_start (see manifest.json), so it
//      runs and attaches its listener before any of the page's own
//      <script> tags have executed.
//   2. The listener is registered in the capture phase, so it receives the
//      event on the way down before it reaches any target-phase or
//      bubble-phase listener the page adds later - regardless of where in
//      the DOM the page's own listener lives.
//
// On a match we call preventDefault() AND stopImmediatePropagation()
// ourselves. stopImmediatePropagation() is the important one: it stops the
// page's own keydown handler(s) from running at all for this event, so a
// lightbox that would otherwise react to "q" (close/navigate/whatever)
// never sees this keystroke either. That avoids a double-effect where both
// the extension switches tabs AND the page does its own thing with the key.
//
// The extension's `activeTab`/host permissions don't give a content script
// any way to call browserAPI.tabs.update() or browserAPI.windows.update()
// directly - those need to run in the background script, which is the
// privileged, single place tab/window state is already managed (and
// serialized through historyLock). So this just forwards a message and lets
// background.js reuse the exact same handleSwitchInvoked() path that
// onClicked and onCommand already use.
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

window.addEventListener('keydown', function(e) {
	// e.code is layout-independent (physical key position), unlike e.key
	// which can vary with keyboard layout/language. Using e.code means this
	// still matches on non-QWERTY layouts where Alt+Q might otherwise
	// produce a different e.key value.
	if (!e.altKey || e.code !== 'KeyQ') {
		return;
	}
	// Ignore other modifiers being held at the same time (e.g. Ctrl+Alt+Q,
	// Alt+Shift+Q) so this only fires for the exact same combo the manifest
	// registers for the commands API, and doesn't collide with some other
	// shortcut that happens to also involve Alt+Q.
	if (e.ctrlKey || e.metaKey || e.shiftKey) {
		return;
	}

	e.preventDefault();
	e.stopImmediatePropagation();

	browserAPI.runtime.sendMessage({type: 'switch-tabs'}).catch(err => {
		// The background service worker can be asleep/restarting for a brief
		// moment (MV3 cold start); sendMessage can reject with "receiving end
		// does not exist" in that narrow window. Nothing useful to do about a
		// dropped keypress beyond logging it - the user can just press it again.
		console.debug('[content-script] sendMessage failed', err);
	});
}, true); // capture phase - see comment above.