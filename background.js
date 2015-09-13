var currentTab = null;
var previousTabsByWindow = {};

// set current tab and window on load
initializeWindow();

// Update variables on tab removed
chrome.tabs.onRemoved.addListener(tabRemovedCallback);

// Update variables on window removed
chrome.windows.onRemoved.addListener(windowRemovedCallback);

// Update variables on tab change
chrome.tabs.onSelectionChanged.addListener(selectionChangedCallback);

// Switch tab on button click
chrome.browserAction.onClicked.addListener(switchToPreviousTabCallback);

// Keyboard shortcut toggle function
chrome.commands.onCommand.addListener(function(command) {
  if (command == "toggle") {
    switchToPreviousTabCallback();
  }
});

function getPreviousTabs(callback) { // get _current_ window tabs from previousTabsByWindow
  return getCurrentWindow(function (window) {
    var wKey = getWKey(window.id);

    if (!previousTabsByWindow[wKey]) {
      return initializeWindow(window.id, callback);
    }

    callback && callback(previousTabsByWindow[wKey]);
  });
}

function getCurrentTab(wId, callback) {
  var windowId = wId === chrome.windows.WINDOW_ID_NONE ? chrome.windows.WINDOW_ID_CURRENT : wId;
  chrome.tabs.getSelected(windowId, function(tab) {
    callback(tab.id, tab.windowId);
  });
}

function getCurrentWindow(callback) {
  chrome.windows.getLastFocused({populate: true}, function(window) {
    callback(window);
  });
}

function initializeWindow(wId, callback) {
  getCurrentTab(wId, function(tab, wId) {
    var wKey = getWKey(wId);
    currentTab = tab;
    previousTabsByWindow[wKey] = [currentTab];
    callback && callback(previousTabsByWindow[wKey]);
  });
}

function getWKey(wId) { // generate an object key by window id
  return 'w_' + wId;
}

function windowRemovedCallback(wId) {
  var wKey = getWKey(wId);
  delete previousTabsByWindow[wKey];
}

function tabRemovedCallback(removedId) {
  getPreviousTabs(function (previousTabs) {
      removeTab(previousTabs, removedId);
  });
}

// also removes duplicates
function removeTab(previousTabs, removedId) {
  var index = previousTabs.indexOf(removedId);
  if (index !== -1) {
    previousTabs.splice(index, 1);
  }
}

function selectionChangedCallback(tab) {
  getPreviousTabs(function (previousTabs) {
    removeTab(previousTabs, currentTab);
    previousTabs.push(currentTab);

    currentTab = tab;
  });
}

function switchToPreviousTabCallback() {
  getPreviousTabs(function (previousTabs) {
      switchToPreviousTab(previousTabs);
  });
}

function switchToPreviousTab(previousTabs) {
  var nextTab = previousTabs.pop();
  if (!nextTab) {
    return;
  }

  chrome.tabs.update(nextTab, {selected: true}, function () {
    if (chrome.runtime.lastError && previousTabs.length) { // invalid tab, try next one
        return switchToPreviousTab(previousTabs);
    }
  });
}
