var currentTab = null;
var previousTabs = [];

// set current tab on load
chrome.tabs.getSelected(chrome.windows.WINDOW_ID_CURRENT, function(tab) {
  currentTab = tab.id;
});

// Update variables on tab change
chrome.tabs.onSelectionChanged.addListener(function(tab) {
    previousTabs.push(currentTab);
    currentTab = tab;

    // console.log('current', currentTab, 'previous', previousTab);
    // console.log('previousTabs', previousTabs);
});

// Switch tab on button click
chrome.browserAction.onClicked.addListener(function() {
    switchToPreviousTab();
});

// Keyboard shortcut toggle function
chrome.commands.onCommand.addListener(function(command) {
  if (command == "toggle") {
    switchToPreviousTab();
  }
});

function switchToPreviousTab() {
    // find next tab which is not current, sometimes the next valid
    // tab is the current one, if neighbour was closed
    var nextTab;
    while (previousTabs.length) {
       nextTab = previousTabs.pop();
       if (nextTab !== currentTab) {
            break;
       }
    }

    if (!nextTab) {
        return;
    }

    // console.log('switching to', nextTab);
    chrome.tabs.update(nextTab, {selected: true}, function () {
        if (chrome.runtime.lastError && previousTabs.length) { // invalid tab, try next one
            return switchToPreviousTab();
        }
    });
}
