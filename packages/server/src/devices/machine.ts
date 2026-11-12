/**
 * The name of the computer a pairing page is on, to suggest in the new device's name ("Firefox on my-laptop"): the
 * Tailscale machine name of the address a proxy marked the request with (`X-Forwarded-For`), or the server's own name
 * for a page on the server's computer. A name is never written to the log, and neither is the address it was asked for.
 */
import { z } from "zod";

/** What a name looks like: a computer name's one label (Tailscale's `ComputedName`, a hostname). Anything else is no name. */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
/** A name found for an address is kept this long, and no more than `KEPT_MAX` addresses are kept. */
const KEPT_MS = 10 * 60_000;
const KEPT_MAX = 256;
/** `tailscale whois` answers from the local daemon in a few milliseconds; one that takes longer is cut off. */
const WHOIS_TIMEOUT_MS = 2_000;

const IPV4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

/**
 * The address in its canonical form when it is a Tailscale one (IPv4 in 100.64.0.0/10, IPv6 in fd7a:115c:a1e0::/48),
 * else undefined. Only such an address is ever handed to `whois`.
 */
function tailnetAddress(candidate: string): string | undefined {
  const v4 = IPV4.exec(candidate);
  if (v4 !== null) {
    const [first = 0, second = 0, third = 0, fourth = 0] = v4.slice(1).map(Number);
    if (third > 255 || fourth > 255) return undefined;
    return first === 100 && second >= 64 && second <= 127 ? candidate : undefined;
  }
  if (!candidate.includes(":") || !/^[0-9A-Fa-f:]+$/.test(candidate)) return undefined;
  let canonical: string;
  try {
    // The URL parser checks an IPv6 address and writes it lower case with its zeros compressed. The prefix's three
    // groups are not zero, so a compressed address in the /48 always starts with them.
    canonical = new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  return canonical.startsWith("fd7a:115c:a1e0:") ? canonical : undefined;
}

const checked = (name: string | undefined): string | null =>
  name !== undefined && NAME_SHAPE.test(name) ? name : null;

/** Names the computer a request's page is on; null when no valid name is known. */
export type MachineNamer = (request: Request) => Promise<string | null>;

export interface MachineNamesDeps {
  /** The machine name Tailscale gives an address of its network; undefined when it knows none. */
  readonly whois: (ip: string) => Promise<string | undefined>;
  /** The name of the server's own computer. */
  readonly hostname: () => string;
  readonly now?: () => number;
}

/**
 * Names the computer a request's page is on. With `X-Forwarded-For`, the request came through a proxy
 * (Tailscale Serve): the header's last address, the one the proxy added (a client can send addresses of its own before
 * it), is looked up with `whois` when it is a Tailscale one; any other address has no name. Without it, the page is on
 * the server's computer. Null when no valid name is known, and for any
 * failure. A name is kept 10 minutes for its address (the 256 newest addresses), a failed lookup too.
 */
export function createMachineNames(deps: MachineNamesDeps): MachineNamer {
  const now = deps.now ?? Date.now;
  const kept = new Map<string, { readonly at: number; readonly name: Promise<string | null> }>();

  const lookup = async (address: string): Promise<string | null> => {
    try {
      return checked(await deps.whois(address));
    } catch {
      return null;
    }
  };

  const named = (address: string): Promise<string | null> => {
    const at = now();
    const held = kept.get(address);
    if (held !== undefined && at - held.at < KEPT_MS) return held.name;
    kept.delete(address);
    if (kept.size >= KEPT_MAX) {
      const oldest = kept.keys().next();
      if (!oldest.done) kept.delete(oldest.value);
    }
    const name = lookup(address);
    kept.set(address, { at, name });
    return name;
  };

  return async (request) => {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded === null) {
      try {
        return checked(deps.hostname());
      } catch {
        return null;
      }
    }
    const address = tailnetAddress((forwarded.split(",").at(-1) ?? "").trim());
    return address === undefined ? null : named(address);
  };
}

/** The part of `tailscale whois --json` this reads. */
const Whois = z.object({ Node: z.object({ ComputedName: z.string() }) });

/** The machine name of a Tailscale address, from the local daemon (`tailscale whois`); undefined when it gives none. */
export async function tailscaleWhois(ip: string): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["tailscale", "whois", "--json", ip], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), WHOIS_TIMEOUT_MS);
    try {
      const text = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) return undefined;
      const parsed = Whois.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.Node.ComputedName : undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}
