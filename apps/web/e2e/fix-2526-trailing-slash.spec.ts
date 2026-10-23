import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, narrowTo, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

// Issue #2526: the Other folder field opens a path with a trailing separator as the folder it names, and says what to
// type for a relative path (instead of always "Enter an absolute folder path.").
const REFUSAL = "Type the full path to the folder, for example /home/you/project.";

async function typeOtherFolder(page: Page, path: string): Promise<void> {
  await page.getByRole("combobox", { name: "Workspace folder" }).selectOption("__other__");
  await page.getByRole("textbox", { name: "Other folder path" }).fill(path);
  await page.getByRole("button", { name: "Use" }).click();
}

async function expectStyled(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  await waitForFiniteAnimations(page);
}

realTest("a path with a trailing separator opens the folder it names", async ({ realApp }) => {
  const { folder, otherFolder } = realApp;
  const page = await realApp.open();
  const picker = page.getByRole("combobox", { name: "Workspace folder" });
  await expect(picker).toHaveValue(folder);
  await typeOtherFolder(page, `${otherFolder}/`);
  await expect(picker).toHaveValue(otherFolder);
  await expect(page.getByRole("textbox", { name: "Other folder path" })).toHaveCount(0);
  await expect(page.getByText("No sessions in this folder")).toBeVisible();
  await expect(page.getByText(REFUSAL)).toHaveCount(0);
  await expectStyled(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "fix-2526-opened-light.png") });

  const dark = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await typeOtherFolder(dark, `${otherFolder}/`);
  await expect(dark.getByRole("combobox", { name: "Workspace folder" })).toHaveValue(otherFolder);
  await expectStyled(dark);
  await dark.screenshot({ path: join(screenshots, "fix-2526-opened-dark.png") });
});

realTest(
  "a relative path is refused with the sentence that says what to type",
  async ({ realApp }) => {
    const page = await realApp.open();
    await typeOtherFolder(page, "projects/x");
    await expect(page.getByText(REFUSAL)).toBeVisible();
    await expect(page.getByText("Enter an absolute folder path.")).toHaveCount(0);
    await expectStyled(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-2526-refused-light.png") });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await typeOtherFolder(dark, "projects/x");
    await expect(dark.getByText(REFUSAL)).toBeVisible();
    await expectStyled(dark);
    await dark.screenshot({ path: join(screenshots, "fix-2526-refused-dark.png") });

    const phone = await realApp.open();
    await narrowTo(phone);
    await phone.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(phone.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "true");
    await waitForFiniteAnimations(phone);
    await typeOtherFolder(phone, "projects/x");
    await expect(phone.getByText(REFUSAL)).toBeVisible();
    await expectStyled(phone);
    await phone.screenshot({ path: join(screenshots, "fix-2526-refused-narrow.png") });
  },
);
