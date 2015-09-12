Toggle-Switch-Recent-Last-Tabs
==============================

Chrome extension to Toggle between your current and last used (focused) tab with a keyboard shortcut (ALT+Q by default) or mouse click on the icon.

Download: https://chrome.google.com/webstore/detail/toggle-switch-recent-last/odhjcgnlbagjllfbilicalpigimhdcll

Changelog
=========

**1.5**

 - Implemented tab history, keep track of tab switch order
 - When closing tabs, switch to last focused existing tab.

**1.4.2**

 - Reverted back to toggle command instead of browser action

**1.4.1**

 - Removed unneeded permissions
 - Attempt to fix problem when default shortcut is not set.

**1.4**

- On tab closure jump back to the previous one before that.

**1.3**

- Minor fixes
- Tried to introduce previousPreviousTab

**1.2**

- Switched from onSelectionChanged to onActivated: When opening a new tab, switch to last focused tab is now possible.
- Use local storage and persistent: true: Fixes issue with Chrome not saving the tab variables persistently

**1.1**

- Now uses native Chrome keyboard command instead of JS

**1.0**

- Initial release
