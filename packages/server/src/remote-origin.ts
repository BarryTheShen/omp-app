/**
 * The one remote address a user may open the app from: their computer's Tailscale name served over HTTPS by
 * `tailscale serve`, for example `https://devbox.tail1234.ts.net`. The server still listens on 127.0.0.1 only;
 * `tailscale serve` passes the browser's Host on (`r.Out.Host = r.In.Host`, tailscale `ipn/ipnlocal/serve.go`), so
 * the server allows that host and origin besides its own. Only `*.ts.net` over HTTPS is accepted: the app runs commands
 * on this computer, so it is never opened to the internet.
 */
export interface RemoteOrigin {
  /** What the browser sends as Origin: `https://devbox.tail1234.ts.net`. */
  readonly origin: string;
  /** What the browser sends as Host through `tailscale serve`: `devbox.tail1234.ts.net`. */
  readonly host: string;
}

/** The environment variable that names the remote origin. */
export const REMOTE_ORIGIN_ENV = "OMP_APP_REMOTE_ORIGIN";

/**
 * Reads `OMP_APP_REMOTE_ORIGIN`: undefined when it is unset or empty, else the origin and host it names. Throws a plain
 * reason when the value is not `https://<name>.ts.net` with nothing after the name.
 */
export function parseRemoteOrigin(value: string | undefined): RemoteOrigin | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `${REMOTE_ORIGIN_ENV} must be an address like https://<computer>.<tailnet>.ts.net, not "${text}".`,
    );
  }
  const bare =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net") || url.port !== "" || !bare) {
    throw new Error(
      `${REMOTE_ORIGIN_ENV} must be the computer's Tailscale address over HTTPS, like https://<computer>.<tailnet>.ts.net, with nothing after it, not "${text}".`,
    );
  }
  return { origin: url.origin, host: url.host };
}
