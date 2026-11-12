/**
 * The toolbar button opens the sidebar: one panel for the window, pointed at the tab in front. Called in the click's own
 * turn: Firefox opens the sidebar only while it handles the person's click.
 */
browser.action.onClicked.addListener(() => {
  void browser.sidebarAction.open();
});
