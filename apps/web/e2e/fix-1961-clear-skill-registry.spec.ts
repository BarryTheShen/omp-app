import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

async function openSkills(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("option", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
}

realTest(
  "clearing Skill Registry saves and reloads as omp's default state",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openSkills(page);
    const registry = page.getByRole("textbox", { name: "Skill Registry", exact: true });
    await expect(registry).toBeVisible();
    await registry.fill("");
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
    await expect(page.getByText("Enter a valid skill registry URL.", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("Applied", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
    await openSkills(page);
    await expect(page.getByRole("textbox", { name: "Skill Registry", exact: true })).toHaveValue(
      "",
    );
    expect(realApp.problems).toEqual([]);
  },
);
