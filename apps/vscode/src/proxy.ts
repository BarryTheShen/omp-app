/**
 * The proxy VS Code sends an address's connections through, decided as VS Code decides it for its window (and so for
 * the panel's page) and for the extension's own connections: the `http.proxy` setting, else a proxy named in VS Code's
 * environment (`https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`), whatever the system's proxy settings say.
 * `http.noProxy`, else the environment's `no_proxy`, lists what goes around it, as Chromium's bypass rules; local names
 * (no dot) and this computer's own addresses always go around it. A proxy often can't reach an address on the person's
 * own network, such as a Tailscale name, which only this computer's resolver knows.
 */

/** What VS Code decides its proxy from. */
export interface ProxySettings {
  /** The `http.proxy` setting; empty when unset. */
  readonly proxy: string;
  /** The `http.noProxy` setting. */
  readonly noProxy: readonly string[];
  /** The environment VS Code runs with. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The proxy an address's connections go through, without any credentials, and where VS Code took it from. */
export interface ProxyInUse {
  readonly proxy: string;
  readonly from: string;
}

const PROXY_VARIABLES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;

/** The proxy VS Code sends connections to `address` (an origin) through; null when they go to it directly. */
export function proxyFor(address: string, settings: ProxySettings): ProxyInUse | null {
  const set = settings.proxy.trim();
  const variable = PROXY_VARIABLES.find((name) => (settings.env[name] ?? "").trim() !== "");
  const used =
    set !== ""
      ? { proxy: set, from: "VS Code's http.proxy setting" }
      : variable === undefined
        ? null
        : {
            proxy: (settings.env[variable] ?? "").trim(),
            from: `the ${variable} environment variable`,
          };
  if (used === null) return null;
  const url = new URL(address);
  const scheme = url.protocol.slice(0, -1);
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const port = url.port === "" ? (scheme === "https" ? "443" : "80") : url.port;
  if (alwaysDirect(host)) return null;
  const listed = settings.noProxy.map((rule) => rule.trim()).filter((rule) => rule !== "");
  const rules =
    listed.length > 0
      ? listed
      : (settings.env.no_proxy || settings.env.NO_PROXY || "")
          .split(/[,;]/)
          .map((rule) => rule.trim());
  if (rules.some((rule) => bypasses(rule, scheme, host, port))) return null;
  return { proxy: withoutCredentials(used.proxy), from: used.from };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv4 address as a number; null for anything else. */
function ipv4(text: string): number | null {
  const parts = IPV4.exec(text);
  if (parts === null) return null;
  const bytes = parts.slice(1).map(Number);
  if (bytes.some((byte) => byte > 255)) return null;
  return bytes.reduce((value, byte) => value * 256 + byte, 0);
}

/** Chromium's own bypass, and VS Code's `<local>`: this computer's names and addresses, link-local ones, dotless names. */
function alwaysDirect(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^fe[89ab]/.test(host)
  )
    return true;
  const address = ipv4(host);
  if (address !== null) return address >>> 24 === 127 || address >>> 16 === (169 << 8) + 254;
  return !host.includes(".") && !host.includes(":");
}

/** Whether a bypass rule (Chromium's form: `[scheme://]pattern[:port]`, `*`, or an IPv4 range) covers the address. */
function bypasses(rule: string, scheme: string, host: string, port: string): boolean {
  let rest = rule.toLowerCase();
  if (rest === "" || rest === "<-loopback>") return false;
  if (rest === "*") return true;
  if (rest === "<local>") return !host.includes(".") && !host.includes(":");
  const schemed = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(rest);
  if (schemed !== null) {
    if (schemed[1] !== scheme) return false;
    rest = schemed[2] ?? "";
  }
  const range = /^([\d.]+)\/(\d{1,2})$/.exec(rest);
  if (range !== null) {
    const base = ipv4(range[1] ?? "");
    const address = ipv4(host);
    const bits = Number(range[2]);
    if (base === null || address === null || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (base & mask) >>> 0 === (address & mask) >>> 0;
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  const parts = bracketed ?? /^(.*?)(?::(\d+))?$/.exec(rest);
  const pattern = parts?.[1] ?? "";
  const wanted = parts?.[2];
  if (wanted !== undefined && wanted !== port) return false;
  const glob = pattern.startsWith(".") ? `*${pattern}` : pattern;
  const expression = glob
    .split("*")
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(host);
}

/** The proxy's address without a user name or password, which never go on screen. */
function withoutCredentials(proxy: string): string {
  try {
    const url = new URL(proxy);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return proxy.slice(proxy.lastIndexOf("@") + 1);
  }
}
