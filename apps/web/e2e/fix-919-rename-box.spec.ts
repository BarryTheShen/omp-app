import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #919. A chat's rename box opened empty, so the title the row shows was neither in the box nor
 * selected, and a person had to retype it. The box now opens with that title, all of it selected: typing
 * replaces it, Escape still cancels, and Enter with no change renames nothing.
 */
realTest.use({ seedSessions: 12 });

const SEEDED = "Seeded chat 11";

/** The sidebar row whose title starts with `title`. */
function rowFor(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(title) });
}

/** Hovers a row, opens its More actions and picks Rename, the way a person does with the mouse. */
async function openRenameBox(page: Page, title: string): Promise<Locator> {
  await rowFor(page, title).hover();
  await page.getByRole("button", { name: `More actions for ${title}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${title}` })
    .getByRole("menuitem", { name: `Rename ${title}` })
    .click();
  return page.getByRole("textbox", { name: `Rename ${title}` });
}

/** The box's text, and where its selection starts and ends. */
function selectionOf(box: Locator): Promise<number[]> {
  return box.evaluate((element: HTMLInputElement) => [
    element.selectionStart ?? -1,
    element.selectionEnd ?? -1,
    element.value.length,
  ]);
}

realTest(
  "the rename box opens with the chat's title shown and selected, and Escape cancels",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(rowFor(page, SEEDED)).toBeVisible({ timeout: 30_000 });

    const box = await openRenameBox(page, SEEDED);
    await expect(box).toHaveValue(SEEDED);
    expect(await selectionOf(box)).toEqual([0, SEEDED.length, SEEDED.length]);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-919-rename-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-919-rename-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    await box.press("Escape");
    await expect(page.getByRole("textbox", { name: `Rename ${SEEDED}` })).toHaveCount(0);
    await expect(rowFor(page, SEEDED)).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "on a phone-width screen the rename box opens with the chat's title shown and selected",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 390, height: 844 });
    // The narrow layout applies after the resize: wait for it, then open the chat list's drawer.
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(rowFor(page, SEEDED)).toBeVisible({ timeout: 60_000 });

    const box = await openRenameBox(page, SEEDED);
    await expect(box).toHaveValue(SEEDED);
    expect(await selectionOf(box)).toEqual([0, SEEDED.length, SEEDED.length]);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-919-rename-narrow.png") });

    await box.press("Escape");
    await expect(page.getByRole("textbox", { name: `Rename ${SEEDED}` })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Enter in the rename box with the title unchanged leaves the chat as it was",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(rowFor(page, SEEDED)).toBeVisible({ timeout: 30_000 });

    const box = await openRenameBox(page, SEEDED);
    await expect(box).toHaveValue(SEEDED);
    await box.press("Enter");
    await expect(page.getByRole("textbox", { name: `Rename ${SEEDED}` })).toHaveCount(0);
    await expect(rowFor(page, SEEDED)).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
