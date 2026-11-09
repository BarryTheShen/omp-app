/**
 * The pages that may show the app's lite view (`/lite`, #2843) in a frame, such as a notes app's side panel: the origins
 * in `OMP_APP_FRAME_ANCESTORS`, separated by spaces, and those saved in Settings → App → Integrations (`embedders.ts`).
 * Each is one of:
 * - a Tailscale address over HTTPS (`https://<name>.ts.net`, a port allowed, as another app on the computer is served on
 *   one), or a loopback address with its port (`http://127.0.0.1:<port>`, `http://localhost:<port>`);
 * - a browser extension's or an editor's panel: every extension of a kind (`moz-extension:` for Firefox and Zen,
 *   `chrome-extension:` for Chrome and Edge), one extension (`moz-extension://<uuid>`, `chrome-extension://<id>`), or VS
 *   Code's webviews (`vscode-webview:` with `vscode-file:`, the window that holds them).
 * Nothing else: the app runs commands on this computer, so no page of the internet may hold it, as for
 * `OMP_APP_REMOTE_ORIGIN`. A panel still has to be paired, as any device. None named: no page may frame the app.
 */
export const FRAME_ANCESTORS_ENV = "OMP_APP_FRAME_ANCESTORS";

/** The panels of a kind that may frame the app, as CSP names them. */
export const PANEL_SOURCES = [
  "moz-extension:",
  "chrome-extension:",
  "vscode-webview:",
  "vscode-file:",
] as const;

const FIREFOX_EXTENSION =
  /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHROME_EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;

/** What the error says the value may be. */
export const FRAME_ANCESTOR_FORMS =
  "a Tailscale address over HTTPS (https://<computer>.<tailnet>.ts.net, a port allowed), a loopback address with its port (http://127.0.0.1:<port>), or a browser extension's or editor's panel (moz-extension:, chrome-extension:, one extension's own address, vscode-webview:, vscode-file:)";

/** One page or panel kind as CSP names it, or null for anything else. */
export function frameAncestorOf(text: string): string | null {
  const value = text.trim();
  if ((PANEL_SOURCES as readonly string[]).includes(value)) return value;
  const lower = value.toLowerCase();
  if (FIREFOX_EXTENSION.test(lower) || CHROME_EXTENSION.test(lower)) return lower;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const bare =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  const tailscale = url.protocol === "https:" && url.hostname.endsWith(".ts.net");
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.port !== "";
  return bare && (tailscale || loopback) ? url.origin : null;
}

/** The origins `OMP_APP_FRAME_ANCESTORS` names, each once; throws a plain reason for a value it does not take. */
export function parseFrameAncestors(value: string | undefined): readonly string[] {
  const origins = new Set<string>();
  for (const text of (value ?? "").split(/\s+/)) {
    if (text === "") continue;
    const origin = frameAncestorOf(text);
    if (origin === null) {
      throw new Error(
        `${FRAME_ANCESTORS_ENV} takes ${FRAME_ANCESTOR_FORMS}, separated by spaces, not "${text}".`,
      );
    }
    origins.add(origin);
  }
  return [...origins];
}
