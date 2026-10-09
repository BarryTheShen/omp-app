import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { realTest, screenshots } from "./real-omp";

/**
 * Issues 831, 832 and 833 on the real app (real server, real omp, the fake model) with 12 old chats
 * in the folder, all closed at the start: a chat nobody has open is renamed from its row, and the new
 * title shows at once and after a reload; Enter in the rename box saves without opening another chat;
 * Enter on a row's More actions button still opens its menu; renaming the open chat updates its row.
 */
realTest.use({ seedSessions: 12 });

const USER_MESSAGE = '[data-slot="u1-message-row"][data-role="user"]';

/** The sidebar row whose title starts with `title` (a title here never is a prefix of another). */
function rowFor(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(title) });
}

/** Hovers a row, opens its More actions and picks Rename, the way a person does with the mouse. */
async function startRenameFromRow(page: Page, title: string): Promise<Locator> {
  await rowFor(page, title).hover();
  await page.getByRole("button", { name: `More actions for ${title}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${title}` })
    .getByRole("menuitem", { name: `Rename ${title}` })
    .click();
  return page.getByRole("textbox", { name: `Rename ${title}` });
}

/** The sidebar's styles are loaded (a token background, not the browser default) before a capture. */
async function expectStylesLoaded(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
    "href",
    /\/assets\/.+\.css$/,
  );
  const background = await page
    .locator('aside[aria-label="Sessions"]')
    .evaluate((element: HTMLElement) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "a chat nobody has open is renamed from its row, and the new title stays after a reload",
  async ({ realApp }) => {
    const page = await realApp.open();
    await expect(rowFor(page, "Seeded chat 11")).toBeVisible({ timeout: 30_000 });

    const box = await startRenameFromRow(page, "Seeded chat 11");
    await box.fill("Closed rename probe");
    await box.press("Enter");

    // The row shows the new title at once; nothing waits for a turn to end.
    await expect(rowFor(page, "Closed rename probe")).toBeVisible({ timeout: 5_000 });
    await expect(rowFor(page, "Seeded chat 11")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);

    await page.reload();
    await expect(rowFor(page, "Closed rename probe")).toBeVisible({ timeout: 30_000 });
    await expect(rowFor(page, "Seeded chat 11")).toHaveCount(0);
  },
);

realTest(
  "Enter in the rename box saves the rename and leaves the open chat on screen",
  async ({ realApp }) => {
    const page = await realApp.open();
    await rowFor(page, "Seeded chat 5").click();
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 5" })).toBeVisible({
      timeout: 45_000,
    });

    const box = await startRenameFromRow(page, "Seeded chat 5");
    await box.fill("Enter keeps this chat");
    await box.press("Enter");

    await expect(rowFor(page, "Enter keeps this chat")).toBeVisible({ timeout: 5_000 });
    // Enter did not open the first chat of the list in place of this one.
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 12" })).toHaveCount(0);
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 5" })).toBeVisible();
  },
);

realTest(
  "Enter on a row's More actions button opens its menu, and opens no chat",
  async ({ realApp }) => {
    const page = await realApp.open();
    await expect(rowFor(page, "Seeded chat 6")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "More actions for Seeded chat 6" }).focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("menu", { name: "Actions for Seeded chat 6" })).toBeVisible();
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 6" })).toHaveCount(0);
  },
);

realTest("renaming the open chat updates its row at once", async ({ realApp }) => {
  const page = await realApp.open();
  await rowFor(page, "Seeded chat 12").click();
  await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 12" })).toBeVisible({
    timeout: 45_000,
  });

  const box = await startRenameFromRow(page, "Seeded chat 12");
  await box.fill("Open rename probe");
  await box.press("Enter");

  await expect(rowFor(page, "Open rename probe")).toBeVisible({ timeout: 5_000 });
  await expect(rowFor(page, "Seeded chat 12")).toHaveCount(0);
});

realTest(
  "the rename box and the renamed row look right in light, dark and at 390 px",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });

    const light = await realApp.open();
    await expect(rowFor(light, "Seeded chat 11")).toBeVisible({ timeout: 30_000 });
    const lightBox = await startRenameFromRow(light, "Seeded chat 11");
    await lightBox.fill("Light rename probe");
    await expectStylesLoaded(light);
    await light.screenshot({ path: join(screenshots, "session-rename-light-box.png") });
    await lightBox.press("Enter");
    await expect(rowFor(light, "Light rename probe")).toBeVisible({ timeout: 5_000 });
    await expectStylesLoaded(light);
    await light.screenshot({ path: join(screenshots, "session-rename-light-row.png") });

    const dark = await realApp.open();
    await dark.getByRole("radio", { name: "Dark" }).click();
    await expect(dark.locator("html")).toHaveClass(/\bdark\b/);
    await expect(rowFor(dark, "Light rename probe")).toBeVisible({ timeout: 30_000 });
    const darkBox = await startRenameFromRow(dark, "Light rename probe");
    await darkBox.fill("Dark rename probe");
    await expectStylesLoaded(dark);
    await dark.screenshot({ path: join(screenshots, "session-rename-dark-box.png") });
    await darkBox.press("Escape");
    await dark.getByRole("radio", { name: "System" }).click();

    const narrow = await realApp.open();
    await narrow.setViewportSize({ width: 390, height: 844 });
    await narrow.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(rowFor(narrow, "Light rename probe")).toBeVisible({ timeout: 30_000 });
    const narrowBox = await startRenameFromRow(narrow, "Light rename probe");
    await narrowBox.fill("Narrow rename probe");
    await expectStylesLoaded(narrow);
    await narrow.screenshot({ path: join(screenshots, "session-rename-narrow-box.png") });
  },
);
