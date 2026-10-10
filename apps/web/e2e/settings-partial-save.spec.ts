import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const APPEARANCE_NOTICE = "Not saved: Auto-Resize Images.";
const NOTIFICATIONS_NOTICE = "Not saved: Error Notification.";
const REFUSAL =
  "This setting could not be written to the settings file. Check the settings file for an entry that conflicts with it.";

async function openAppearanceImages(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("tab", { name: "Images", exact: true }).click();
  const section = page.locator('[data-s1-appearance-section="S1.appearanceImages"]');
  await expect(section).toBeVisible();
  return section;
}

async function openInteractionNotifications(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("option", { name: "Notifications", exact: true }).click();
  const region = page.getByRole("region", { name: "Interaction settings" });
  await expect(region.getByRole("combobox", { name: "Error Notification" })).toBeVisible();
  return region;
}

realTest(
  "a save omp refuses in part names the setting it did not save, and the next save is not a false conflict",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    // `images` is a plain value in the settings file, so the server cannot write the `images.*`
    // settings under it. `terminal.showImages` is written, so one save applies part of its changes
    // and refuses the rest.
    await writeFile(join(realApp.agentDir, "config.yml"), "images: not-a-section\n");
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const section = await openAppearanceImages(page);
    const showImages = section.getByRole("checkbox", { name: "Show Inline Images" });
    const autoResize = section.getByRole("checkbox", { name: "Auto-Resize Images" });
    const showBefore = await showImages.isChecked();
    await showImages.click();
    await autoResize.click();
    await section.getByRole("button", { name: "Save changes" }).click();

    const notice = page.getByRole("alert").filter({ hasText: APPEARANCE_NOTICE });
    await expect(page.getByText(APPEARANCE_NOTICE, { exact: true })).toBeVisible();
    await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(section.getByText("Applied", { exact: true })).toHaveCount(0);
    await expect(section.getByText("Not saved", { exact: true })).toHaveCount(1);
    await expect(showImages).toBeChecked({ checked: !showBefore });
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toContain(`showImages: ${String(!showBefore)}`);
    await notice.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "settings-partial-save-light.png"),
      fullPage: true,
    });

    // The refused setting is still staged, so the next save is refused for the same reason. It must
    // not be reported as a conflict with a change nobody else made.
    await section.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(APPEARANCE_NOTICE, { exact: true })).toBeVisible();
    await expect(page.getByText("Another settings writer changed")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await notice.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "settings-partial-save-narrow.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const darkSection = await openAppearanceImages(dark);
    await darkSection.getByRole("checkbox", { name: "Show Inline Images" }).click();
    await darkSection.getByRole("checkbox", { name: "Auto-Resize Images" }).click();
    await darkSection.getByRole("button", { name: "Save changes" }).click();
    await expect(dark.getByText(APPEARANCE_NOTICE, { exact: true })).toBeVisible();
    await dark.getByRole("alert").filter({ hasText: APPEARANCE_NOTICE }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "settings-partial-save-dark.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a partly saved Notifications section names the setting omp did not save, with no Retry and no Applied",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    // `error` is a plain value in the settings file, so omp cannot hold `error.notify` under it: that
    // write is refused. `completion.notify` is written, so one save applies part of the section.
    await writeFile(join(realApp.agentDir, "config.yml"), "error: not-a-section\n");
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const region = await openInteractionNotifications(page);
    const completion = region.getByRole("combobox", { name: "Completion Notification" });
    const errorNotify = region.getByRole("combobox", { name: "Error Notification" });
    const completionBefore = await completion.inputValue();
    const completionAfter = completionBefore === "on" ? "off" : "on";
    await completion.selectOption(completionAfter);
    const errorBefore = await errorNotify.inputValue();
    await errorNotify.selectOption(errorBefore === "off" ? "on" : "off");
    await region.getByRole("button", { name: "Save changes" }).click();

    const notice = region.getByRole("alert").filter({ hasText: NOTIFICATIONS_NOTICE });
    await expect(region.getByText(NOTIFICATIONS_NOTICE, { exact: true })).toBeVisible();
    await expect(region.getByText(REFUSAL, { exact: true })).toBeVisible();
    await expect(region.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(region.getByText("Applied", { exact: true })).toHaveCount(0);
    await expect(region.getByText("Not saved", { exact: true })).toHaveCount(1);
    await expect(region.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toMatch(new RegExp(`completion:\\n\\s+notify: ${completionAfter}`));
    await notice.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "settings-partial-save-notifications-light.png"),
      fullPage: true,
    });
    // A second light capture, scrolled to the row of the setting omp did not save, so its mark shows.
    await errorNotify.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "settings-partial-save-notifications-row.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await notice.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "settings-partial-save-notifications-narrow.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const darkRegion = await openInteractionNotifications(dark);
    const darkCompletion = darkRegion.getByRole("combobox", { name: "Completion Notification" });
    const darkError = darkRegion.getByRole("combobox", { name: "Error Notification" });
    const darkCompletionBefore = await darkCompletion.inputValue();
    await darkCompletion.selectOption(darkCompletionBefore === "on" ? "off" : "on");
    const darkErrorBefore = await darkError.inputValue();
    await darkError.selectOption(darkErrorBefore === "off" ? "on" : "off");
    await darkRegion.getByRole("button", { name: "Save changes" }).click();
    await expect(darkRegion.getByText(NOTIFICATIONS_NOTICE, { exact: true })).toBeVisible();
    await darkRegion
      .getByRole("alert")
      .filter({ hasText: NOTIFICATIONS_NOTICE })
      .scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "settings-partial-save-notifications-dark.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
