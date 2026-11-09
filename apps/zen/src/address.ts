import { appAddressOf } from "@omp-app/embed";

/** Where the extension keeps what it needs between starts (`storage.local`). */
export const STORED = {
  /** omp app's address, as the person typed it, checked. */
  app: "app",
  /** This browser's device key, from pairing once: the panels sign in with it. */
  key: "deviceKey",
} as const;

/** The address kept, or null before the person gave one. */
export async function storedAppAddress(): Promise<string | null> {
  const kept = (await browser.storage.local.get(STORED.app))[STORED.app];
  if (typeof kept !== "string") return null;
  const checked = appAddressOf(kept);
  return "address" in checked ? checked.address : null;
}
