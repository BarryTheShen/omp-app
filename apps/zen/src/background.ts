/**
 * The toolbar button: the panel opens on the tab it was pressed on, bound to it (its own chat). Both calls go out in the
 * click's own turn: Firefox opens the sidebar only while it handles the person's click.
 */
browser.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    void browser.sidebarAction.setPanel({
      tabId: tab.id,
      panel: browser.runtime.getURL(`panel.html?tab=${tab.id}`),
    });
  }
  void browser.sidebarAction.open();
});
