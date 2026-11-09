/** Where the extension keeps what it needs between starts (`storage.local`). */
export const STORED = {
  /** omp app's address, as the person typed it, checked. */
  app: "app",
  /** This browser's device key, from pairing once: the panels sign in with it. */
  key: "deviceKey",
} as const;

/**
 * omp app's address from what the person typed, or why it is not one: an `https` address (the computer's tailnet
 * address), or a loopback `http` address with its port (the app on this computer). Only the origin is kept.
 */
export function appAddressOf(
  typed: string,
): { readonly address: string } | { readonly problem: string } {
  const text = typed.trim();
  if (text === "") return { problem: "Type omp app's address." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: `"${text}" is not an address. It starts with https://.` };
  }
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.port !== "";
  if (url.protocol !== "https:" && !loopback)
    return {
      problem:
        "omp app's address starts with https:// (its tailnet address), or is http://127.0.0.1 with its port on this computer.",
    };
  return { address: url.origin };
}

/** The address kept, or null before the person gave one. */
export async function storedAppAddress(): Promise<string | null> {
  const kept = (await browser.storage.local.get(STORED.app))[STORED.app];
  if (typeof kept !== "string") return null;
  const checked = appAddressOf(kept);
  return "address" in checked ? checked.address : null;
}
