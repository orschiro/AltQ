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

chrome.tabs.onDetached.addListener(function(tabId, info) {
	removeTabFromWindow(info.oldWindowId, tabId);
});

chrome.tabs.onRemoved.addListener(function(tabId, info) {
	if (info.isWindowClosing) {
		return;
	}
	removeTabFromWindow(info.windowId, tabId);
});

chrome.windows.onFocusChanged.addListener(async function(windowId) {
	if (currentWindowId !== -1) {
		// Save currentTabId.
		windows[currentWindowId].currentTabId = currentTabId;
	}
	currentWindowId = windowId;
	if (currentWindowId === -1) {
		currentTabId = null;
		return;
	}

	if (!windows.hasOwnProperty(currentWindowId)) { // Newly visited window.
		currentTabId = await resolveCurrentTabId();
		populateCurrentWindow();
	} else {
		currentTabId = windows[currentWindowId].currentTabId;
	}
	validateAllHistory();
});

chrome.windows.onRemoved.addListener(function(windowId) {
	delete windows[windowId];
});

function populateCurrentWindow() {
	let tabHistory = {};
	tabHistory[-1] = {id: null}; // Dummy start.
	tabHistory[currentTabId] = {id: currentTabId, prev: tabHistory[-1]};
	tabHistory[-1].next = tabHistory[currentTabId];
	windows[currentWindowId] = {tabHistory: tabHistory};
}

function removeTabFromWindow(windowId, tabId) {
	let tabHistory = windows[windowId].tabHistory;
	if (tabHistory.hasOwnProperty(tabId)) { // Visited tab.
		let removingTab = tabHistory[tabId];
		if (tabId === currentTabId) {
			// Remove current tab, and switch to the last tab.
			delete removingTab.prev.next;
			currentTabId = removingTab.prev.id;
			if (!defaultTabClosingBehavior && currentTabId) {
				currentTabJustRemoved = true;
				chrome.tabs.update(currentTabId, {active: true});
			}
		} else {
			removingTab.prev.next = removingTab.next;
			removingTab.next.prev = removingTab.prev;
		}
		delete tabHistory[tabId];
	}
}

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

function validateAllHistory() {
	for (let windowId in windows) {
		if (windows.hasOwnProperty(windowId)) {
			validateHistory(windowId);
		}
	}
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

init();
