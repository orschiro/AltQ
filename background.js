var previousTab;
var currentTab;

// General functions
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


// Keyboard shortcut toggle function
chrome.commands.onCommand.addListener(function(command) {
  if (command == "toggle") {

    chrome.tabs.getSelected(null, function(tab) {
        previousTab = tab.id;
        currentTab = null;
    });

    chrome.tabs.update(previousTab, {selected: true});
  }
});


