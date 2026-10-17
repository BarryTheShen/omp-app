import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSkills(page: Page): Promise<{ dialog: Locator; control: Locator }> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Interaction", exact: true }).click();
  const skillsOption = dialog.getByRole("option", { name: "Skills", exact: true });
  await expect(skillsOption).toBeVisible({ timeout: 20_000 });
  await skillsOption.click();
  const control = dialog.getByRole("textbox", { name: "Skill Registry", exact: true });
  await expect(control).toBeVisible({ timeout: 20_000 });
  return { dialog, control };
}

async function expectStyled(dialog: Locator): Promise<void> {
  await expect
    .poll(() => dialog.evaluate((element) => getComputedStyle(element).backgroundColor), {
      timeout: 10_000,
    })
    .not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "shows the Skills registry setting and saves it to omp config.yml",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const { dialog, control } = await openSkills(page);
    await expect(control).toHaveValue("https://skills.omp.sh", { timeout: 20_000 });
    await expect(
      dialog.getByText("The Skillshare registry that omp's skill command", { exact: false }),
    ).toBeVisible();
    await control.fill("https://registry.example.test");
    const save = dialog.getByRole("button", { name: "Save changes", exact: true });
    await save.click();
    await expect(save).toBeDisabled({ timeout: 20_000 });
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/registryUrl:\s*https:\/\/registry\.example\.test/);
    await page.reload();
    const reloaded = await openSkills(page);
    await expect(reloaded.control).toHaveValue("https://registry.example.test", {
      timeout: 20_000,
    });
    await reloaded.control.scrollIntoViewIfNeeded();
    await expectStyled(reloaded.dialog);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1930-skills-registry-url-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("renders the Skills setting in dark mode", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const { dialog, control } = await openSkills(page);
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 20_000 });
  await control.scrollIntoViewIfNeeded();
  await expectStyled(dialog);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1930-skills-registry-url-dark.png") });
  expect(realApp.problems).toEqual([]);
});

realTest("renders the Skills setting at 390px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open();
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog, control } = await openSkills(page);
  await control.scrollIntoViewIfNeeded();
  await expectStyled(dialog);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1930-skills-registry-url-narrow.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
