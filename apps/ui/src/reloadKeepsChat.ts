/**
 * Which page loads come back to the chat the page showed, where a launch opens on a new chat on a phone (#2819):
 * - the app's own reload (its banner's Reload): a mark in the tab's session storage, which a reload keeps and a launch
 *   does not have;
 * - any load within an hour of the page last being up (the issue's choice B): iOS reloads a Home Screen app it put away,
 *   and to the page that looks the same as a launch. When the page was last up is kept in local storage as the page goes
 *   away (hidden, or unloaded).
 */
const KEY = "omp-app:reload-keeps-chat";
const LAST_UP_KEY = "omp-app:last-up";
/** How long after the page was last up a load still comes back to its chat (#2819). */
const KEEP_CHAT_MS = 60 * 60 * 1000;

/** Reloads the page; the chat shown now is shown again after it. */
export function reloadKeepingChat(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // No session storage (a private window's full storage): a plain reload.
  }
  window.location.reload();
}

function appReload(): boolean {
  try {
    const kept = sessionStorage.getItem(KEY) === "1";
    sessionStorage.removeItem(KEY);
    return kept;
  } catch {
    return false;
  }
}

function upLately(): boolean {
  try {
    const at = Number(localStorage.getItem(LAST_UP_KEY));
    return at > 0 && Date.now() - at < KEEP_CHAT_MS;
  } catch {
    return false;
  }
}

/** Whether this page load comes back to the chat the page showed, read once as the page loads (the mark is used up). */
export const loadKeepsChat: boolean = appReload() || upLately();

function noteUp(): void {
  try {
    localStorage.setItem(LAST_UP_KEY, String(Date.now()));
  } catch {
    // No local storage: every load counts as a launch.
  }
}

// Noted as the page goes away, after this load's own reading above.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") noteUp();
});
window.addEventListener("pagehide", noteUp);
