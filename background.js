var previousTab;
var previousPreviousTab;
var currentTab;

// Switch tab on button click
chrome.browserAction.onClicked.addListener(function(tab) {
    chrome.tabs.update(previousTab, {selected: true});
});

// Keyboard shortcut toggle function
chrome.commands.onCommand.addListener(function(command) {
  if (command == "toggle") {
    chrome.tabs.update(previousTab, {selected: true});
  }
});

// Update variables on tab change
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

// Update variables on tab creation
chrome.tabs.onCreated.addListener(function(tab) {
    previousPreviousTab = previousTab;
    console.log("Previous Previous Tab is" + previousPreviousTab);
    console.log("Previous Tab is" + previousTab);
});

// Update variables on tab removal
chrome.tabs.onRemoved.addListener(function(tab) {
    previousTab = previousPreviousTab;
    console.log("Previous Previous Tab is" + previousPreviousTab);
    console.log("Previous Tab is" + previousTab);
});