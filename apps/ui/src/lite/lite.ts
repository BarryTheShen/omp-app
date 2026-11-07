import type { ThreadId } from "@omp-app/contracts";

/**
 * The lite view's address (#2843): the server serves the app's page there, and only there may the pages it is told of
 * (`OMP_APP_FRAME_ANCESTORS`) frame it, such as a notes app's side panel.
 */
const LITE_PATH = "/lite";

/** Whether this page is the lite view: one chat and its message box, for another app's side panel. */
export const isLiteView = (): boolean => window.location.pathname === LITE_PATH;

/** The mode the page that frames the lite view asks for (`?theme=light` or `?theme=dark`); null follows the system. */
export function liteThemeMode(): "light" | "dark" | null {
  const asked = new URLSearchParams(window.location.search).get("theme");
  return asked === "light" || asked === "dark" ? asked : null;
}

/** The full app, showing the chat (`#chat=<id>`, `takeLinkChat`), or as it was left for a chat with no id yet. */
export const fullAppAddress = (threadId: ThreadId | null): string =>
  threadId === null ? "/" : `/#chat=${encodeURIComponent(threadId)}`;
