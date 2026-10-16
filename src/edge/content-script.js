// Fallback path for the extension's keyboard shortcut (Alt+Q by default).
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
//   1. This script is injected at document_start (see background.js), so it
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
//
// WHICH combo to match is no longer hardcoded: the user can change the
// shortcut (options page / browser shortcut settings), and content scripts
// can't call commands.getAll() themselves. background.js mirrors the real,
// current shortcut into storage.local under `shortcutBinding` as a plain
// descriptor ({code, alt, ctrl, shift, meta}); this script reads it once at
// startup and follows storage.onChanged, so open tabs update live.
//   - key missing from storage  -> manifest default (Alt+Q)
//   - value is null             -> no shortcut assigned, do nothing
(function() {
	// This file can be injected more than once into the same page (the
	// registered content script plus the one-off executeScript catch-up in
	// background.js, or after the setting is toggled off and on again). A
	// second copy would send a second message per keypress, which switches
	// tabs and then immediately switches back.
	if (window.__altqFallbackInstalled) {
		return;
	}
	window.__altqFallbackInstalled = true;

	const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

	const STORAGE_KEY = 'shortcutBinding';
	const DEFAULT_BINDING = {code: 'KeyQ', alt: true, ctrl: false, shift: false, meta: false};
	let binding = DEFAULT_BINDING;

	function applyStored(value) {
		// undefined = never written -> default; null = explicitly unassigned.
		binding = value === undefined ? DEFAULT_BINDING : value;
	}

	try {
		browserAPI.storage.local.get(STORAGE_KEY).then(result => {
			applyStored(result[STORAGE_KEY]);
		}).catch(err => {
			console.debug('[content-script] could not read shortcut binding', err);
		});
		browserAPI.storage.onChanged.addListener(function(changes, area) {
			if (area === 'local' && changes[STORAGE_KEY]) {
				applyStored(changes[STORAGE_KEY].newValue);
			}
		});
	} catch (err) {
		// Keep working with the default binding if storage is unavailable.
		console.debug('[content-script] storage unavailable', err);
	}

	window.addEventListener('keydown', function(e) {
		if (!binding) {
			return;
		}
		// e.code is layout-independent (physical key position), unlike e.key
		// which can vary with keyboard layout/language. Using e.code means
		// this still matches on non-QWERTY layouts where the shortcut might
		// otherwise produce a different e.key value.
		//
		// Every modifier must match exactly (not just "at least"), so this
		// only fires for the same combo registered with the commands API and
		// doesn't collide with some other shortcut that merely includes it
		// (e.g. Ctrl+Alt+Q when the shortcut is Alt+Q).
		if (e.code !== binding.code ||
				e.altKey !== binding.alt ||
				e.ctrlKey !== binding.ctrl ||
				e.shiftKey !== binding.shift ||
				e.metaKey !== binding.meta) {
			return;
		}

		e.preventDefault();
		e.stopImmediatePropagation();

		browserAPI.runtime.sendMessage({type: 'switch-tabs'}).catch(err => {
			// The background service worker can be asleep/restarting for a
			// brief moment (MV3 cold start); sendMessage can reject with
			// "receiving end does not exist" in that narrow window. Nothing
			// useful to do about a dropped keypress beyond logging it - the
			// user can just press it again.
			console.debug('[content-script] sendMessage failed', err);
		});
	}, true); // capture phase - see comment above.
})();
