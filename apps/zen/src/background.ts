/**
 * The toolbar button opens the panel beside the page: one panel for the window, pointed at the tab in front. Firefox
 * and Zen: the sidebar, opened in the click's own turn (Firefox opens it only while it handles the person's click).
 * Chrome and Edge: the side panel, which the browser itself opens on the button's click once told to.
 */
if ("sidebarAction" in browser) {
  browser.action.onClicked.addListener(() => {
    void browser.sidebarAction.open();
  });
} else {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
