let previousTab;
let currentTab;

function init() {
	chrome.tabs.query({
		active: true,
		lastFocusedWindow: true,
	}, function(tab) {
		previousTab = null;
		currentTab = tab[0].id;
	});
}

chrome.browserAction.onClicked.addListener(function(tab) {
	chrome.tabs.update(previousTab, {active: true});
});

chrome.tabs.onActivated.addListener(function(info) {
	previousTab = currentTab;
	currentTab = info.tabId;
});

init();
