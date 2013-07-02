var previousTab;
var currentTab;

function init() {
	chrome.tabs.getSelected(null, function(tab) {
	previousTab = tab.id;
	currentTab = null;
	});
}

// Toggle if user clicks on the extension icon
chrome.browserAction.onClicked.addListener(function(tab) {
	chrome.tabs.update(previousTab, {selected: true});
});

// Toggle if user presses the keyboard shortcut
chrome.commands.onCommand.addListener(function(command) {
  if (command == "toggle") {

	init();

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

		chrome.tabs.update(previousTab, {selected: true});
	}
});