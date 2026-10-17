import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/** Opens Settings from the header, then the Shell tab's Bash section, where the approval rules sit. */
async function openBashSection(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Shell", exact: true }).click();
  await settings
    .getByRole("listbox", { name: "Shell settings sections" })
    .getByRole("option", { name: "Bash", exact: true })
    .click();
  return settings;
}

realTest(
  "Add rule from the keyboard moves focus to the new rule's command field",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const settings = await openBashSection(page);
    const rules = settings.getByRole("group", { name: "Bash Approval Patterns", exact: true });
    const commandFields = rules.getByLabel(/Command pattern \d+$/);
    const before = await commandFields.count();
    const addRule = rules.getByRole("button", { name: "Add rule", exact: true });
    await expect(addRule).toBeEnabled();
    await addRule.focus();
    await page.keyboard.press("Enter");
    await expect(commandFields).toHaveCount(before + 1);
    await expect(
      rules.getByLabel(/Bash Approval Patterns: Command pattern \d+$/, { exact: false }),
    ).toBeFocused();
  },
);
