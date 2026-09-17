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
		toggle.checked = !!(response && response.granted);
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

refreshState();
