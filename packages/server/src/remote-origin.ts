/**
 * The one other address the app may be opened at, besides this computer's own: an HTTPS address that something on this
 * computer serves the app at, such as a reverse proxy (Caddy, nginx), a tunnel, or Tailscale Serve, for example
 * `https://omp.example.com`. The server still listens on 127.0.0.1 only; what serves the address passes requests on to
 * it, with the browser's Host (Tailscale Serve, Caddy) or its own loopback one (nginx's default), and the browser's
 * Origin either way. It must be HTTPS: the sign-in key and the chats cross the network, and the app runs commands on
 * this computer.
 */
export interface RemoteOrigin {
  /** What the browser sends as Origin: `https://omp.example.com`. */
  readonly origin: string;
  /** What the browser sends as Host for it: `omp.example.com`, with the port when it is not 443. */
  readonly host: string;
}

/** The environment variable that names the remote origin. */
export const REMOTE_ORIGIN_ENV = "OMP_APP_REMOTE_ORIGIN";

/**
 * Reads `OMP_APP_REMOTE_ORIGIN`: undefined when it is unset or empty, else the origin and host it names. Throws a plain
 * reason when the value is not an HTTPS address with nothing after it.
 */
export function parseRemoteOrigin(value: string | undefined): RemoteOrigin | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `${REMOTE_ORIGIN_ENV} must be an HTTPS address like https://omp.example.com, not "${text}".`,
    );
  }
  const bare =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  if (url.protocol !== "https:" || url.hostname === "" || url.hostname.includes("*") || !bare) {
    throw new Error(
      `${REMOTE_ORIGIN_ENV} must be the HTTPS address the app is served at, like https://omp.example.com (a port allowed), with nothing after it, not "${text}".`,
    );
  }
  return { origin: url.origin, host: url.host };
}
