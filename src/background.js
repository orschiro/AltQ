/*
 * windows object
 *     {windowId}
 *         currentTabId
 *         tabHistory
 *             "-1"
 *                 tab object (dummy start)
 *             {tabId}
 *                 tab object
 *
 * tab object
 *     id
 *     prev
 *     next
 */
let windows = {};
let currentWindowId;
let currentTabId;
let currentTabJustRemoved = false; // No-use if `defaultTabClosingBehavior`.
let defaultTabClosingBehavior = true;

// TODO: chrome.runtime.onInstalled.addListener(function callback)
// TODO: tab moved?

function init() {
	chrome.contextMenus.create({
		type: "checkbox",
		title: chrome.i18n.getMessage("contextMenu"),
		checked: false,
		contexts: ["browser_action"],
		onclick: function(info, tab) {
			defaultTabClosingBehavior = !info.checked;
		},
	});

	chrome.windows.getLastFocused({}, async function(win) {
		if (!win.focused) {
			console.error(win);
			return;
		}
		currentWindowId = win.id;
		currentTabId = await resolveCurrentTabId();
		populateCurrentWindow();
	});
}

chrome.browserAction.onClicked.addListener(function(tab) {
	let prevTab = windows[currentWindowId].tabHistory[currentTabId].prev;
	if (prevTab.id) { // Check if is dummy start.
		chrome.tabs.update(prevTab.id, {active: true});
	}
});

chrome.tabs.onActivated.addListener(function(info) {
	console.log("ACT");
	// After current tab is closed, this listener is triggered twice. Chrome
	// first switches to its default tab. Then, we switch to our last tab which
	// can be identified with `currentTabId`.
	if (currentTabJustRemoved) {
		currentTabJustRemoved = false;
		return;
	}
	if (info.tabId === currentTabId) {
		return;
	}

	// When new window is created, `tabs.onActivated` will be triggered first
	// followed by `windows.onFocusChanged`.
	if (info.windowId !== currentWindowId) {
		return;
	}

	let prevTabId = currentTabId || -1; // Might be dummy start.
	currentTabId = info.tabId;

	let tabHistory = windows[currentWindowId].tabHistory;
	if (!tabHistory.hasOwnProperty(currentTabId)) { // Newly visited tab.
		tabHistory[currentTabId] = {id: currentTabId};
	}
	let currentTab = tabHistory[currentTabId];
	if (currentTab.prev) {
		currentTab.prev.next = currentTab.next;
		currentTab.next.prev = currentTab.prev;
	}

	let prevTab = tabHistory[prevTabId];
	prevTab.next = currentTab;
	currentTab.prev = prevTab;
	delete currentTab.next;
	validateHistory();
});

chrome.tabs.onRemoved.addListener(function(tabId, info) {
	console.log("TRM");
	if (info.isWindowClosing) {
		return;
	}
	let tabHistory = windows[info.windowId].tabHistory;
	if (tabHistory.hasOwnProperty(tabId)) { // Visited tab.
		// Remove tab from `tabHistory`.
		let removedTab = tabHistory[tabId];
		if (tabId === currentTabId) {
			// Current tab is removed. Switch to the last tab.
			delete removedTab.prev.next;
			currentTabId = removedTab.prev.id;
			if (!defaultTabClosingBehavior && currentTabId) {
				currentTabJustRemoved = true;
				chrome.tabs.update(currentTabId, {active: true});
			}
		} else {
			removedTab.prev.next = removedTab.next;
			removedTab.next.prev = removedTab.prev;
		}
		delete tabHistory[tabId];
	}
	validateHistory();
});

chrome.windows.onFocusChanged.addListener(async function(windowId) {
	console.log("FOC");
	if (windowId === -1 || windowId === currentWindowId) {
		return;
	}
	windows[currentWindowId].currentTabId = currentTabId; // Save currentTabId.
	currentWindowId = windowId;
	if (!windows.hasOwnProperty(currentWindowId)) { // Newly visited window.
		currentTabId = await resolveCurrentTabId();
		populateCurrentWindow();
	} else {
		currentTabId = windows[currentWindowId].currentTabId;
	}
	validateAllHistory();
});

chrome.windows.onRemoved.addListener(function(windowId) {
	console.log("WRM");
	delete windows[windowId];
});

function resolveCurrentTabId() {
	return new Promise(function(resolve) {
		chrome.tabs.query({
			active: true,
			windowId: currentWindowId,
		}, function(tab) {
			resolve(tab[0].id);
		});
	});
}

function populateCurrentWindow() {
	let tabHistory = {};
	tabHistory[-1] = {id: null}; // Dummy start.
	tabHistory[currentTabId] = {id: currentTabId, prev: tabHistory[-1]};
	tabHistory[-1].next = tabHistory[currentTabId];
	windows[currentWindowId] = {tabHistory: tabHistory};
}

function validateHistory(windowId) {
	windowId = windowId || currentWindowId;
	let currentTab = windows[windowId].tabHistory[-1];
	let path = windowId + ": " + currentTab.id;
	while (currentTab.next) {
		if (currentTab.next.prev !== currentTab) {
			console.error("Broken history!");
			console.error(windowId, windows[windowId]);
			return;
		}
		currentTab = currentTab.next;
		path = path + " => " + currentTab.id;
	}
	console.debug(path);
}

function validateAllHistory() {
	for (let windowId in windows) {
		if (windows.hasOwnProperty(windowId)) {
			validateHistory(windowId);
		}
	}
}

init();
