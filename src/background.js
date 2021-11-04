// ExtensionPay
const extpay = ExtPay('alt--q-switch-recent-active-tabs')
let extpayCheck;
let paid;
let trial;
let trialStartedAt;

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

function switchTabs() {
	let prevTab = tabHistory[currentTabId].prev;
	if (prevTab.id) { // Check if is dummy start.
		chrome.tabs.update(prevTab.id, {active: true});
}}

chrome.browserAction.onClicked.addListener(function(tab) {
	const now = new Date();
	const sevenDays = 1000*60*60*24*7; // in milliseconds
	if (!extpayCheck == true || !trial == true) {
		extpay.getUser().then(user => {
			paid = user.paid;
			trialStartedAt = user.trialStartedAt;
			extpayCheck = true;
		})
	}
	
	if (paid == true) {
		switchTabs()
	}

	else {
	
		if (trialStartedAt && (now - trialStartedAt) > sevenDays) {
		// user's trial expired
		trialExpired = true;
		extpay.openPaymentPage()
		extpayCheck = false;
		}

		if (trialStartedAt && (now - trialStartedAt) < sevenDays) {
			// user's trial is active
			trial = true;
			switchTabs()
		}

		 if (!trialStartedAt) {
			// user trial is inactive
			extpay.openTrialPage('7-day')
		}	

		if (trial == true) {
			switchTabs()
		}

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