(function () {

    'use strict';

    function initialise() {
        var switchOnClose = document.getElementById('switch-on-close');

        var settings = localStorage.getItem('tsrltSettings');

        if (settings !== null && settings !== 'null') {
            settings = JSON.parse(settings);
        } else {
            settings = {switchOnClose: false};
            localStorage.setItem('tsrltSettings', JSON.stringify(settings));
        }

        switchOnClose.checked = settings.switchOnClose;
    }

    function getSettings() {
        var settings = localStorage.getItem('tsrltSettings');

        if (settings !== null && settings !== 'null') {
            settings = JSON.parse(settings);
        } else {
            settings = {switchOnClose: false};
            localStorage.setItem('tsrltSettings', JSON.stringify(settings));
        }
        return settings;
    }

    var readyStateCheckInterval = window.setInterval(function () {
        if (document.readyState === 'complete') {

            window.clearInterval(readyStateCheckInterval);

            initialise();

            var saveButton = document.getElementById('save-btn');
            var cancelButton = document.getElementById('cancel-btn');
            var switchOnClose = document.getElementById('switch-on-close');

            saveButton.onclick = function (e) {
                var settings = getSettings();
                settings.switchOnClose = switchOnClose.checked;
                chrome.extension.getBackgroundPage().switchToLastTabOnExit = settings.switchOnClose;
                localStorage.setItem('tsrltSettings', JSON.stringify(settings));
                alert("Saved!");
                window.close();
            };
            cancelButton.onclick = function (e) {
                window.close();
            };
        }
    }, 50);

}());
