import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

realTest.setTimeout(180_000);

/**
 * Issue #934. A retry count is a whole number of 0 or more. Settings used to accept -1 and 1.5, save them and say
 * "Saved", and an emptied field turned into 0 with no message. Each of those now shows the rule and cannot be saved.
 */

/** Opens Settings, its Model tab and one of that tab's sections. */
async function openModelSection(page: Page, section: string): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Model" }).click();
  await dialog.getByRole("option", { name: section }).click();
  return dialog;
}

/** Centres the field in the dialog's scroll area, so a screenshot shows it with its message. */
async function centre(field: Locator): Promise<void> {
  await field.evaluate((element) => element.scrollIntoView({ block: "center" }));
}

const RULE = "Enter a whole number, 0 or more.";

realTest(
  "a retry count of -1, 1.5 or nothing shows the rule and cannot be saved; a whole number can",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelSection(page, "Retry & Fallback");
    const attempts = dialog.getByRole("spinbutton", { name: "Retry Attempts" });
    await expect(attempts).toBeVisible({ timeout: 30_000 });
    const save = dialog.getByRole("button", { name: "Save changes" });

    await attempts.fill("-1");
    await expect(dialog.getByText(RULE)).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(attempts).toHaveValue("-1");
    await centre(attempts);
    await page.screenshot({ path: join(screenshots, "fix-934-retry-minus-one-light.png") });

    await attempts.fill("1.5");
    await expect(dialog.getByText(RULE)).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(attempts).toHaveValue("1.5");

    await attempts.fill("");
    await expect(dialog.getByText(RULE)).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(attempts).toHaveValue("");

    await page.emulateMedia({ colorScheme: "dark" });
    await centre(attempts);
    await page.screenshot({ path: join(screenshots, "fix-934-retry-empty-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await centre(attempts);
    await page.screenshot({ path: join(screenshots, "fix-934-retry-empty-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    await attempts.fill("3");
    await expect(dialog.getByText(RULE)).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 20_000 });
    await expect(attempts).toHaveValue("3");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await centre(attempts);
    await page.screenshot({ path: join(screenshots, "fix-934-retry-saved-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a sampling value outside omp's range is refused, and -1 (the provider's default) is not",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelSection(page, "Sampling");
    const save = dialog.getByRole("button", { name: "Save changes" });
    const topP = dialog.getByRole("spinbutton", { name: "Top P" });
    await expect(topP).toBeVisible({ timeout: 30_000 });
    const topPRule = "Enter a number from 0 to 1, or -1 for the provider's default.";

    await topP.fill("1.5");
    await expect(dialog.getByText(topPRule)).toBeVisible();
    await expect(save).toBeDisabled();

    await topP.fill("-1");
    await expect(dialog.getByText(topPRule)).toHaveCount(0);

    await topP.fill("0.9");
    await expect(dialog.getByText(topPRule)).toHaveCount(0);
    await expect(save).toBeEnabled();
    expect(realApp.problems).toEqual([]);
  },
);
