var previousPreviousTab;
var wasRemoved;
var previousTab;
var currentTab;

// Update variables on tab creation
chrome.tabs.onCreated.addListener(function(tabId, changeInfo, tab) {
    previousPreviousTab = previousTab;
    // console.log("Previous Previous Tab is" + previousPreviousTab);
    // console.log("Previous Tab is" + previousTab);
});

// Update variables on tab removal
chrome.tabs.onRemoved.addListener(function(tabId, changeInfo, tab) {
    previousTab = previousPreviousTab;
    wasRemoved = true;
    // console.log("Previous Previous Tab is" + previousPreviousTab);
    // console.log("Previous Tab is" + previousTab);
});

// Update variables on tab change
chrome.tabs.onSelectionChanged.addListener(function(tab) {
    if (previousTab == null) {
        previousTab = tab;
    }
    if (currentTab == null) {
        currentTab = tab;
    }
    else if (wasRemoved == true) {
        currentTab = tab;
        wasRemoved = false;
    }
    else {
        previousTab = currentTab;
        currentTab = tab;
    }
});

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