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

/** What the framing app may set for its assistant (#2845); null keeps the app's own. */
export interface LiteChoices {
  /** The empty chat's greeting (`?greeting=`), in place of "What are we working on?". */
  readonly greeting: string | null;
  /** Rows under the greeting that send their text (`?suggest=a|b|c`); none when none are given. */
  readonly suggestions: readonly string[];
  /** The empty message box's text (`?placeholder=`), in place of "Message omp". */
  readonly placeholder: string | null;
}

const MAX_GREETING = 120;
const MAX_PLACEHOLDER = 80;
const MAX_SUGGESTION = 60;
const MAX_SUGGESTIONS = 5;

/**
 * The framing app's greeting, suggestions and placeholder from the address, read once at load. A text is trimmed; one
 * that is empty or longer than its limit is ignored (a greeting 120 characters, a placeholder 80, a suggestion 60), and
 * at most the first 5 different suggestions are kept.
 */
export function liteChoices(search: string): LiteChoices {
  const params = new URLSearchParams(search);
  const text = (name: string, max: number): string | null => {
    const value = (params.get(name) ?? "").trim();
    return value === "" || value.length > max ? null : value;
  };
  const suggestions = new Set<string>();
  for (const each of (params.get("suggest") ?? "").split("|")) {
    const value = each.trim();
    if (value === "" || value.length > MAX_SUGGESTION) continue;
    suggestions.add(value);
    if (suggestions.size === MAX_SUGGESTIONS) break;
  }
  return {
    greeting: text("greeting", MAX_GREETING),
    suggestions: [...suggestions],
    placeholder: text("placeholder", MAX_PLACEHOLDER),
  };
}
