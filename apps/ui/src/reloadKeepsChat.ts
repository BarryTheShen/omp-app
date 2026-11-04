/**
 * A reload the app asks for itself (its banner's Reload) comes back to the chat it showed, where a launch opens on a new
 * chat on a phone (#2819). The mark lives in the tab's session storage, which a reload keeps and a launch does not have.
 */
const KEY = "omp-app:reload-keeps-chat";

/** Reloads the page; the chat shown now is shown again after it. */
export function reloadKeepingChat(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // No session storage (a private window's full storage): a plain reload.
  }
  window.location.reload();
}

/** Whether this page load is the app's own reload, read once as the page loads (the mark is used up). */
export const reloadKeepsChat: boolean = (() => {
  try {
    const kept = sessionStorage.getItem(KEY) === "1";
    sessionStorage.removeItem(KEY);
    return kept;
  } catch {
    return false;
  }
})();
