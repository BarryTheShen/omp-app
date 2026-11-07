/**
 * The pages that may show the app's lite view (`/lite`, #2843) in a frame, such as a notes app's side panel: the origins
 * in `OMP_APP_FRAME_ANCESTORS`, separated by spaces. Each is a Tailscale address over HTTPS (`https://<name>.ts.net`, a
 * port allowed, as another app on the computer is served on one) or a loopback address with its port
 * (`http://127.0.0.1:<port>`, `http://localhost:<port>`). Nothing else: the app runs commands on this computer, so no page
 * of the internet may hold it, as for `OMP_APP_REMOTE_ORIGIN`. Unset or empty: no page may frame the app, as before.
 */
export const FRAME_ANCESTORS_ENV = "OMP_APP_FRAME_ANCESTORS";

/** The origins `OMP_APP_FRAME_ANCESTORS` names, each once; throws a plain reason for a value it does not take. */
export function parseFrameAncestors(value: string | undefined): readonly string[] {
  const origins = new Set<string>();
  for (const text of (value ?? "").split(/\s+/)) {
    if (text === "") continue;
    const refused = new Error(
      `${FRAME_ANCESTORS_ENV} takes Tailscale addresses over HTTPS (https://<computer>.<tailnet>.ts.net, a port allowed) or a loopback address with its port (http://127.0.0.1:<port>), separated by spaces, not "${text}".`,
    );
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw refused;
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
    if (!bare || !(tailscale || loopback)) throw refused;
    origins.add(url.origin);
  }
  return [...origins];
}
