import { appAddressOf } from "@omp-app/embed";

/** Where the extension keeps what it needs between starts (`storage.local`). */
export const STORED = {
  /** omp app's address, as the person typed it, checked. */
  app: "app",
  /** This browser's device key, from pairing once: the panels sign in with it. */
  key: "deviceKey",
  /** The address the key was paired with: it is handed to that address only. */
  keyFor: "deviceKeyAddress",
} as const;

/** The address kept, or null before the person gave one. */
export async function storedAppAddress(): Promise<string | null> {
  const kept = (await browser.storage.local.get(STORED.app))[STORED.app];
  if (typeof kept !== "string") return null;
  const checked = appAddressOf(kept);
  return "address" in checked ? checked.address : null;
}

/**
 * This browser's key for omp app at `app`, or null: a key paired with another address is never handed to this one (a
 * changed address, or another program on the same port, would receive it). A key kept before keys named their address
 * counts as another address's: the panel pairs once more.
 */
export async function keyFor(app: string): Promise<string | null> {
  const kept = await browser.storage.local.get([STORED.key, STORED.keyFor]);
  const key = kept[STORED.key];
  return typeof key === "string" && kept[STORED.keyFor] === app ? key : null;
}

/** Keeps the key the panel got by pairing with `app`, with that address. */
export async function keepKeyFor(app: string, key: string): Promise<void> {
  await browser.storage.local.set({ [STORED.key]: key, [STORED.keyFor]: app });
}

/** Forgets this browser's key: the next panel pairs again. */
export async function forgetKey(): Promise<void> {
  await browser.storage.local.remove([STORED.key, STORED.keyFor]);
}

/** Saves omp app's address; a key paired with another address is forgotten. Says whether one was. */
export async function saveAppAddress(app: string): Promise<boolean> {
  const kept = await browser.storage.local.get([STORED.key, STORED.keyFor]);
  const forgotten = kept[STORED.key] !== undefined && kept[STORED.keyFor] !== app;
  if (forgotten) await forgetKey();
  await browser.storage.local.set({ [STORED.app]: app });
  return forgotten;
}
