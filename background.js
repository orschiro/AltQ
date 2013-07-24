var previousTab;
var currentTab;

// General functions
chrome.browserAction.onClicked.addListener(function(tab) {
    chrome.tabs.update(previousTab, {selected: true});
});

chrome.tabs.onActivated.addListener(function(tab) {
    if (previousTab == null) {
        previousTab = tab;
        // Save it using the Chrome extension storage API.
		chrome.storage.sync.set({'value': previousTab}, function() {
            // Notify that we saved.
			message('Settings saved');
        });
		
    }
    if (currentTab == null) {
        currentTab = tab;
        // Save it using the Chrome extension storage API.
		chrome.storage.sync.set({'value': currentTab}, function() {
            // Notify that we saved.
			message('Settings saved');
        });
    }
    else {
        previousTab = currentTab;
        // Save it using the Chrome extension storage API.
		chrome.storage.sync.set({'value': previousTab}, function() {
            // Notify that we saved.
			message('Settings saved');
        });
        currentTab = tab;
        // Save it using the Chrome extension storage API.
		chrome.storage.sync.set({'value': currentTab}, function() {
            // Notify that we saved.
			message('Settings saved');
        });
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


