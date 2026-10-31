/**
 * `omp-app pair` and `omp-app devices`: the running app's address and launch token come from its instance record (the
 * owner's only), and the server's own pairing routes take them, on the loopback address only.
 */
import {
  type DeviceList,
  formatPairingCode,
  type PAIRING_PATHS,
  type PairedDevice,
  type PairingCode,
} from "@omp-app/contracts";

/** The running app's address and launch token, from the link its instance record keeps. */
export function serverLink(
  link: string,
): { readonly origin: string; readonly token: string } | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  return token === null || token === "" ? undefined : { origin: url.origin, token };
}

/** The device a person named: by its id, the start of its id, or its name (any case); undefined when none or several match. */
export function findDevice(
  devices: readonly PairedDevice[],
  named: string,
): PairedDevice | "none" | "several" {
  const exact = devices.find((device) => device.id === named);
  if (exact !== undefined) return exact;
  const lower = named.toLowerCase();
  const matches = devices.filter(
    (device) =>
      (named.length >= 4 && device.id.startsWith(named)) || device.name.toLowerCase() === lower,
  );
  if (matches.length === 1) return matches[0] as PairedDevice;
  return matches.length === 0 ? "none" : "several";
}

const KIND_WORDS: Record<PairedDevice["kind"], string> = {
  "home-screen-app": "Home Screen app",
  "desktop-window": "desktop window",
  browser: "browser",
};

/** The paired devices, one line each: the start of the id, the name, the kind, and when it last connected. */
export function devicesText(list: DeviceList): string {
  if (list.devices.length === 0) return "No device is paired. omp-app pair makes a code for one.";
  const lines = list.devices.map((device) => {
    const seen = device.lastSeenAt === null ? "never connected" : `last seen ${device.lastSeenAt}`;
    return `  ${device.id.slice(0, 8)}  ${device.name} (${KIND_WORDS[device.kind]}), ${seen}`;
  });
  const waiting =
    list.requests.length === 0
      ? []
      : [
          "",
          `${list.requests.length === 1 ? "A device is" : `${list.requests.length} devices are`} asking to pair: allow or deny it on a paired device.`,
        ];
  return ["Paired devices:", ...lines, ...waiting].join("\n");
}

/** What `omp-app pair` prints: the code, how long it works, and where to enter it. */
export function pairingCodeText(made: PairingCode): string {
  return [
    `Pairing code: ${formatPairingCode(made.code)}`,
    "",
    `On the new device, open ${made.address} and enter the code.`,
    "It works once, for 10 minutes. Running omp-app pair again makes a new code, and this one stops working.",
  ].join("\n");
}

/** Calls one of the server's own pairing routes with the launch token. */
export async function callPairing(
  link: { readonly origin: string; readonly token: string },
  path: (typeof PAIRING_PATHS)[keyof typeof PAIRING_PATHS],
  init: { readonly method: "GET" | "POST"; readonly body?: unknown },
): Promise<unknown> {
  const response = await fetch(`${link.origin}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${link.token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (value as { error?: unknown }).error;
    throw new Error(typeof error === "string" ? error : `the app answered ${response.status}`);
  }
  return value;
}
