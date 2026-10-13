import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

realTest.setTimeout(180_000);

/**
 * Issue #1311. A comma-separated list setting dropped the comma as the person typed it: "read," came back as
 * "read", so a second item could only be pasted in one go. The typed text now stays in the field, and the list is
 * read from it. This types the second item one key at a time, saves it and reads it back.
 */

/** Opens Settings, its Model tab and the Thinking section, which holds the tool-call loop's exempt tools. */
async function openThinking(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Model" }).click();
  await dialog.getByRole("option", { name: "Thinking", exact: true }).click();
  return dialog;
}

/** Centres the field in the dialog's scroll area, so a screenshot shows it with its context. */
async function centre(field: Locator): Promise<void> {
  await field.evaluate((element) => element.scrollIntoView({ block: "center" }));
}

realTest(
  "a list setting keeps the comma while it is typed, so a second item can be typed and saved",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openThinking(page);
    const exempt = dialog.getByRole("textbox", { name: "Tool-Call Loop Exempt Tools" });
    await expect(exempt).toBeVisible({ timeout: 30_000 });
    const save = dialog.getByRole("button", { name: "Save changes" });

    // The field starts with the saved items, so it is emptied first and then typed into, one key at a time.
    await exempt.fill("");
    await expect(exempt).toHaveValue("");
    await exempt.click();
    await exempt.pressSequentially("read");
    await exempt.pressSequentially(",");
    await expect(exempt).toHaveValue("read,");
    await exempt.pressSequentially(" write");
    await expect(exempt).toHaveValue("read, write");
    await expect(save).toBeEnabled();
    await centre(exempt);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1311-list-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await centre(exempt);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1311-list-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await centre(exempt);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1311-list-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    await save.click();
    await expect(save).toBeDisabled({ timeout: 20_000 });
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    // After a reload both items are still there (omp shows the saved list without the spaces).
    await page.reload();
    const reopened = await openThinking(page);
    await expect(
      reopened.getByRole("textbox", { name: "Tool-Call Loop Exempt Tools" }),
    ).toHaveValue(/read,\s*write/, { timeout: 20_000 });
    expect(realApp.problems).toEqual([]);
  },
);
