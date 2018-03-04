var previousTab;
var currentTab;
var previousTabBackup;
var currentTabBackup;

function init() {
	chrome.tabs.getSelected(null, function(tab) {
		previousTab = tab.id;
		currentTab = null;
	});
}

chrome.browserAction.onClicked.addListener(function(tab) {
	chrome.tabs.update(previousTab, {selected: true});
});

chrome.tabs.onSelectionChanged.addListener(function(tab) {
	if (previousTab == null) {
		previousTab = tab;
	}
	if (currentTab == null) {
		currentTab = tab;
	}
	else {
		previousTab = currentTab;
		currentTab = tab;
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
