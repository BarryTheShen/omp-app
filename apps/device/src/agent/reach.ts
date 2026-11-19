/**
 * What this computer can reach (#20), so the person sees in the app what access opens: read from its routes when access
 * turns on (`ip -j route show table all`, iproute2's JSON) and summed up per interface. A default route is "the
 * internet"; a network is named; single addresses (a VPN's peers, a gateway) are counted as machines. Local and
 * link-local entries say nothing about reach and are left out.
 */

interface Route {
  readonly dst?: string;
  readonly dev?: string;
  readonly table?: string;
  readonly type?: string;
}

/** The most lines, and the most networks named per interface. */
const MOST_LINES = 24;
const MOST_NAMED = 4;

export function reachOf(routes: readonly Route[]): string[] {
  const internet = new Set<string>();
  const byDevice = new Map<string, { networks: string[]; machines: number }>();
  for (const route of routes) {
    const { dst, dev } = route;
    if (dst === undefined || dev === undefined || dev === "lo") continue;
    if (route.table === "local" || (route.type !== undefined && route.type !== "unicast")) continue;
    if (dst.startsWith("fe80:")) continue;
    if (dst === "default") {
      internet.add(dev);
      continue;
    }
    const entry = byDevice.get(dev) ?? { networks: [], machines: 0 };
    const prefix = dst.includes("/") ? Number(dst.split("/")[1]) : null;
    const single = prefix === null || prefix === 32 || prefix === 128;
    if (single) entry.machines += 1;
    else if (!entry.networks.includes(dst)) entry.networks.push(dst);
    byDevice.set(dev, entry);
  }
  const lines = [...internet].map((dev) => `the internet (via ${dev})`);
  for (const [dev, { networks, machines }] of byDevice) {
    const parts = networks.slice(0, MOST_NAMED);
    if (networks.length > MOST_NAMED) parts.push(`${networks.length - MOST_NAMED} more networks`);
    if (machines > 0) parts.push(`${machines} machine${machines === 1 ? "" : "s"}`);
    lines.push(`${parts.join(", ")} (via ${dev})`);
  }
  return lines.slice(0, MOST_LINES).map((line) => line.slice(0, 120));
}

/** This computer's reach now; empty when `ip` is missing or fails. */
export async function readReach(): Promise<string[]> {
  const ip = Bun.which("ip");
  if (ip === null) return [];
  try {
    const run = Bun.spawn([ip, "-j", "route", "show", "table", "all"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(run.stdout).text();
    if ((await run.exited) !== 0) return [];
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? reachOf(parsed as Route[]) : [];
  } catch {
    return [];
  }
}
