import { rm } from "node:fs/promises";

/** Errors Windows gives while a program that just ended, or a handle being closed, still holds something in the tree. */
const HELD = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * Removes a folder and everything in it, trying again for a while when something still holds a file in it. Windows
 * refuses to remove an open file, and a program that was just stopped lets go of its folder a moment later. Not
 * `rm`'s `maxRetries`: the Bun the app pins (1.3.14) ignores it. A missing folder is not an error.
 */
export async function removeTree(path: string, waitMs = 2_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "string" || !HELD.has(code) || Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}
