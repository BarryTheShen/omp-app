import { chmod, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

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

/** The text of the new-chat draft stored in the app's data folder, or null when none is stored. */
async function storedNewChatDraft(appDataDir: string): Promise<string | null> {
  const folder = join(appDataDir, "drafts", "folders");
  let files: string[];
  try {
    files = await readdir(folder);
  } catch {
    return null;
  }
  for (const file of files) {
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
