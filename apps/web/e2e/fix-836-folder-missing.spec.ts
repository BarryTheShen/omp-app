import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #836. Typing a folder that does not exist into the picker's "Other folder…" field showed
 * "The host metadata folder was not found." (an internal term), and the picker stayed on "Other
 * folder…" while the list still showed the open folder's chats. It now says the folder doesn't
 * exist, and the picker goes back to the folder that is still open. The other ways a typed path
 * can fail say why in plain words too (the last test).
 */
realTest.use({ seedSessions: 6 });

const MISSING = "/no/such/folder/anywhere";
const REASON = "That folder doesn't exist. Check the path.";

/** Chooses "Other folder…", types a path, and presses Use. */
async function typeOtherFolder(page: Page, path: string): Promise<void> {
  await page.getByRole("combobox", { name: "Workspace folder" }).selectOption("__other__");
  await page.getByRole("textbox", { name: "Other folder path" }).fill(path);
  await page.getByRole("button", { name: "Use" }).click();
}

realTest(
  "real omp: a folder that does not exist says so in plain words, and the picker goes back to the open folder",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const picker = page.getByRole("combobox", { name: "Workspace folder" });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 30_000 });

    await typeOtherFolder(page, MISSING);

    const switcher = page.locator('[data-app-folder-switcher="true"]');
    await expect(switcher.getByRole("alert")).toHaveText(REASON);
    await expect(picker).toHaveValue(realApp.folder);
    await expect(picker).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Other folder path" })).toHaveCount(0);
    await expect(list.getByRole("option").first()).toBeVisible();
    await expect(page.getByText("host metadata")).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-836-missing-folder-light.png") });
  },
);

realTest("real omp: the missing-folder reason reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const list = page.getByRole("listbox", { name: "Session list" });
  await expect(list.getByRole("option").first()).toBeVisible({ timeout: 30_000 });

  await typeOtherFolder(page, MISSING);

  await expect(page.locator('[data-app-folder-switcher="true"]').getByRole("alert")).toHaveText(
    REASON,
  );
  await expect(page.getByRole("combobox", { name: "Workspace folder" })).toHaveValue(
    realApp.folder,
  );
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-836-missing-folder-dark.png") });
});

realTest("real omp: the missing-folder reason reads at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();

  await typeOtherFolder(page, MISSING);

  await expect(page.locator('[data-app-folder-switcher="true"]').getByRole("alert")).toHaveText(
    REASON,
  );
  await expect(page.getByRole("combobox", { name: "Workspace folder" })).toHaveValue(
    realApp.folder,
  );
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-836-missing-folder-390.png") });
});

realTest(
  "real omp: each way a typed path can fail says why in plain words, and the picker stays on the open folder",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const picker = page.getByRole("combobox", { name: "Workspace folder" });
    const list = page.getByRole("listbox", { name: "Session list" });
    const switcher = page.locator('[data-app-folder-switcher="true"]');
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 30_000 });

    // A file, a path inside that file, and a folder with no permission to enter it.
    const notes = join(realApp.folder, "notes.txt");
    const locked = join(realApp.folder, "locked");
    await writeFile(notes, "A file, not a folder.\n");
    await mkdir(join(locked, "child"), { recursive: true });
    await chmod(locked, 0o000);
    try {
      await typeOtherFolder(page, "C:\\Users\\me\\project");
      await expect(switcher.getByRole("alert")).toHaveText(
        "Enter a folder path that starts with /.",
      );
      await expect(picker).toHaveValue(realApp.folder);

      await typeOtherFolder(page, notes);
      await expect(switcher.getByRole("alert")).toHaveText(
        "That path isn't a folder. Check the path.",
      );
      await expect(picker).toHaveValue(realApp.folder);
      await mkdir(screenshots, { recursive: true });
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-836-not-a-folder-light.png") });

      await typeOtherFolder(page, join(notes, "inside"));
      await expect(switcher.getByRole("alert")).toHaveText("That folder couldn't be opened.");
      await expect(picker).toHaveValue(realApp.folder);

      await typeOtherFolder(page, join(locked, "child"));
      await expect(switcher.getByRole("alert")).toHaveText(
        "You don't have permission to open that folder.",
      );
      await expect(picker).toHaveValue(realApp.folder);
      await expect(list.getByRole("option").first()).toBeVisible();
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-836-no-permission-light.png") });
    } finally {
      await chmod(locked, 0o755);
    }
  },
);
