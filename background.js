var previousTab;
var currentTab;

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

chrome.runtime.onMessage.addListener( function(request, sender, sendResponse) {
	if(request.request == "toggle") {
		chrome.tabs.update(previousTab, {selected: true});
	}
});