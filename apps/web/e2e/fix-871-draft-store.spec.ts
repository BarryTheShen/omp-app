import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "@playwright/test";
import {
  APP_ROOT,
  expect,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #871: a draft that cannot be read used to leave the composer disabled with no reason. Here the app's draft
 * folder stops being readable (the store then answers "permission denied"): the composer says why, offers a
 * Retry, and stays disabled only while it says so. Once the folder is readable again, Retry brings the saved
 * text back and the composer is enabled. Real omp.
 */

const TEXT = "saved before the store broke";
const DENIED = /permission denied/;
const NARROW = { width: 390, height: 844 } as const;

realTest.setTimeout(300_000);

/**
 * The text of the new-chat draft committed to the app's data folder, or null while none is. A save writes a temp file
 * and holds a lock file while it runs, then renames the temp file into place. Until both are gone the save is still
 * running, and it can still fail (its rename fails once the folder is locked): what it holds is not a stored draft.
 */
async function storedNewChatDraft(appDataDir: string): Promise<string | null> {
  const folder = join(appDataDir, "drafts", "folders");
  let files: string[];
  try {
    files = await readdir(folder);
  } catch {
    return null;
  }
  if (files.some((file) => file.startsWith(".omp-atomic-"))) return null;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const value: unknown = JSON.parse(await readFile(join(folder, file), "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "draft" &&
      "text" in value &&
      typeof value.text === "string"
    ) {
      return value.text;
    }
  }
  return null;
}

realTest(
  "an unreadable draft says why, with a Retry that brings the saved text back once the folder is readable",
  async ({ realApp }) => {
    const first = await realApp.open();
    const firstComposer = await startChat(first);
    await firstComposer.fill(TEXT);
    await expect.poll(() => storedNewChatDraft(realApp.appDataDir), { timeout: 60_000 }).toBe(TEXT);

    const draftsFolder = join(realApp.appDataDir, "drafts");
    await chmod(draftsFolder, 0o000);
    try {
      const second = await realApp.open();
      const secondComposer = await startChat(second);
      const notice = second.getByRole("alert").filter({ hasText: DENIED });
      await expect(notice).toBeVisible({ timeout: 60_000 });
      await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
      // The composer is disabled only because the notice says why.
      await expect(secondComposer).toBeDisabled();

      await waitForFiniteAnimations(second);
      await second.screenshot({ path: join(screenshots, "fix-871-store-light.png") });
      await second.evaluate(() => document.documentElement.classList.add("dark"));
      await waitForFiniteAnimations(second);
      await second.screenshot({ path: join(screenshots, "fix-871-store-dark.png") });
      await second.evaluate(() => document.documentElement.classList.remove("dark"));
      await second.setViewportSize(NARROW);
      await expect(notice).toBeVisible();
      await waitForFiniteAnimations(second);
      await second.screenshot({ path: join(screenshots, "fix-871-store-narrow.png") });

      await chmod(draftsFolder, 0o755);
      await notice.getByRole("button", { name: "Retry" }).click();
      await expect(secondComposer).toHaveValue(TEXT, { timeout: 60_000 });
      await expect(secondComposer).toBeEnabled();
      await expect(notice).toHaveCount(0);
    } finally {
      await chmod(draftsFolder, 0o755);
    }
    expect(realApp.problems).toEqual([]);
  },
);

test("a save still running is not the stored draft, and the draft is stored once its file is renamed into place", async () => {
  await mkdir(join(APP_ROOT, ".data"), { recursive: true });
  const appDataDir = await mkdtemp(join(APP_ROOT, ".data", "fix-871-helper-"));
  try {
    const folder = join(appDataDir, "drafts", "folders");
    await mkdir(folder, { recursive: true });
    const draft = JSON.stringify({
      version: 1,
      kind: "draft",
      scope: { kind: "folder", folder: "/workspace" },
      text: TEXT,
      attachments: [],
      failedSends: [],
      updatedAt: "2026-10-20T00:00:00.000Z",
    });
    // What a save holds between writing its temp file and renaming it: the temp file, and the lock it runs under.
    const temporary = join(folder, `.omp-atomic-${"b".repeat(32)}.tmp`);
    const lock = join(folder, `.omp-atomic-lock-${"c".repeat(32)}.lock`);
    const committed = join(folder, `${"d".repeat(64)}.json`);
    await writeFile(temporary, draft);
    await writeFile(lock, `${process.pid}\n`);
    expect(await storedNewChatDraft(appDataDir)).toBeNull();

    await rename(temporary, committed);
    await rm(lock);
    expect(await storedNewChatDraft(appDataDir)).toBe(TEXT);
  } finally {
    await rm(appDataDir, { recursive: true, force: true });
  }
});
