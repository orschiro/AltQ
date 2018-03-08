var previousTab;
var currentTab;
var previousTabBackup;
var currentTabBackup;

function init() {
	chrome.tabs.query({
		active: true,
		lastFocusedWindow: true,
	}, function(tab) {
		previousTab = tab[0].id;
		currentTab = null;
	});
}

chrome.browserAction.onClicked.addListener(function(tab) {
	chrome.tabs.update(previousTab, {active: true});
});

chrome.tabs.onActivated.addListener(function(info) {
	if (previousTab == null) {
		previousTab = info.tab;
	}
	if (currentTab == null) {
		currentTab = info.tab;
	} else {
		previousTab = currentTab;
		currentTab = info.tab;
	}
});

chrome.windows.onCreated.addListener(function(tab) {
	previousTabBackup = previousTab;
	currentTabBackup = currentTab;
});

chrome.windows.onRemoved.addListener(function(tab) {
	previousTab = previousTabBackup;
	currentTab = currentTabBackup;
});

init();
