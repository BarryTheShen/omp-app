import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const NOTE = "ignored-notes.md";
const NARROW = { width: 390, height: 844 } as const;

/**
 * Writes the note into the chat's folder, which is not a git repository of its own. The folder sits under this
 * repository's git-ignored `.data/`, so the repository's ignore rules hide every file in it. The @ list must still
 * show the file (issue #827).
 */
async function folderWithNote(folder: string): Promise<void> {
  await writeFile(join(folder, NOTE), "notes\n");
}

realTest(
  "@ lists a file in a folder that the enclosing repository ignores, with no git init",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await folderWithNote(realApp.folder);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("see @ignored-n");
    await expect(page.getByRole("listbox", { name: "File suggestions" })).toBeVisible();
    await expect(page.getByText(NOTE)).toBeVisible({ timeout: 30_000 });

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-827-ignored-folder-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the @ file list reads in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  await folderWithNote(realApp.folder);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = await startChat(page);
  await composer.pressSequentially("see @ignored-n");
  await expect(page.getByText(NOTE)).toBeVisible({ timeout: 30_000 });
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, "fix-827-ignored-folder-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize(NARROW);
  await expect(page.getByText(NOTE)).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-827-ignored-folder-narrow.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
