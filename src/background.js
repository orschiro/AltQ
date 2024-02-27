// ExtensionPay
importScripts('ExtPay.js')
var extpay = ExtPay('alt--q-switch-recent-active-tabs');
extpay.startBackground();
let paid;

let tabHistory = {};
let currentTabId;
let currentTabJustRemoved = false; // No-use if `defaultTabClosingBehavior`.
let defaultTabClosingBehavior = true;

function init() {
	tabHistory[-1] = {id: null}; // Dummy start.
	chrome.tabs.query({
		active: true,
		lastFocusedWindow: true,
	}, function(tab) {
		currentTabId = tab[0].id;
		tabHistory[currentTabId] = {id: currentTabId, prev: tabHistory[-1]};
		tabHistory[-1].next = tabHistory[currentTabId];
		validateHistory();
	});
}

function checkUser() {	
	extpay.getUser().then(user => {
		paid = user.paid;
	});
}

// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension
async function createOffscreen() {
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'keep service worker running',
  }).catch(() => {});
}
chrome.runtime.onStartup.addListener(createOffscreen);
self.onmessage = e => {}; // keepAlive
createOffscreen();

// https://stackoverflow.com/questions/78012294/address-chrome-tabs-inside-different-windows
async function switchTabs() {
  let prevTab = tabHistory[currentTabId].prev;
  if (prevTab.id != null) { // may be 0 in some browsers
    const {windowId} = await chrome.tabs.update(prevTab.id, {active: true});
    chrome.windows.update(windowId, {focused: true});
  }
}

// Check whether new browser version is installed
chrome.runtime.onInstalled.addListener(function(details){
    if(details.reason == "install"){
		extpay.openPaymentPage()
    } else if(details.reason == "update"){
		checkUser()
    }
});

// On browser start
chrome.runtime.onStartup.addListener(function() {
	checkUser()
});

// on click or shortcut
chrome.action.onClicked.addListener(function(tab) {
    if (paid == true) {
        switchTabs()
    } 
	else if (paid == false) {
		extpay.openPaymentPage()	
	}
	else {
        switchTabs()
		checkUser()
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

	let prevTabId = currentTabId || -1; // Might be dummy start.
	currentTabId = info.tabId;

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

function validateHistory() {
	let current = tabHistory[-1];
	let path = current.id;
	while (current.next) {
		if (current.next.prev !== current) {
			console.error("Broken history!");
			console.error(currentTabId, tabHistory);
			return;
		}
		current = current.next;
		path = path + " => " + current.id;
	}
	console.debug(path);
}

init();