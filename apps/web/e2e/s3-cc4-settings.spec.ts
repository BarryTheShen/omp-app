import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
}

async function expectStyled(page: Page, theme: "light" | "dark") {
  const settings = page.getByTestId("settings-screen");
  const colors = await settings.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--sidebar)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { token, actual: getComputedStyle(element).backgroundColor };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

/**
 * The settings screen is a dialog, so the page itself rarely scrolls sideways when the dialog's content is too wide. The
 * check reads three things: the page, the dialog's right edge against the window, and the right edge of everything in the
 * dialog against the dialog's. It measures after the animations have finished, and names the state it measured.
 */
async function expectNoHorizontalOverflow(page: Page, state: string): Promise<void> {
  await waitForFiniteAnimations(page);
  const overflow = await page.evaluate(() => {
    const pageOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const screen = document.querySelector('[data-testid="settings-screen"]');
    if (screen === null) throw new Error("the settings screen is not on the page");
    const frame = screen.getBoundingClientRect();
    const widest = Math.max(
      0,
      ...[...screen.querySelectorAll("*")].map((child) => child.getBoundingClientRect().right),
    );
    return {
      page: pageOverflow,
      screen: frame.right - window.innerWidth,
      content: widest - frame.right,
    };
  });
  expect(overflow.page, `${state}: the page scrolls sideways`).toBeLessThanOrEqual(1);
  expect(
    overflow.screen,
    `${state}: the settings screen is wider than the window`,
  ).toBeLessThanOrEqual(1);
  expect(
    overflow.content,
    `${state}: something in the settings screen is wider than the screen`,
  ).toBeLessThanOrEqual(1);
}

realTest("S3 settings cover CC4 themes, focus, reduced motion and zoom", async ({ realApp }) => {
  const page = await realApp.open();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettings(page);
  await expectStyled(page, "light");
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible();

  const toolsTab = page.getByRole("button", { name: "Tools", exact: true });
  await toolsTab.focus();
  await expect(toolsTab).toBeFocused();
  await page.keyboard.press("Enter");
  const toolsSections = page.getByRole("listbox", { name: "Tools settings sections" });
  await expect(toolsSections).toBeVisible();
  const githubSection = toolsSections.getByRole("option", { name: "GitHub", exact: true });
  await githubSection.focus();
  await expect(githubSection).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
  await expect(page.getByText("GitHub Cache Soft TTL (seconds)", { exact: true })).toBeVisible();
  await expect(page.getByText("GitHub Cache Hard TTL (seconds)", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page, "light, 1280 px");
  const reducedDuration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--duration-base").trim(),
  );
  expect(reducedDuration).toBe(".01ms");
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "s3-cc4-settings-light.png"), fullPage: true });

  const dark = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await dark.emulateMedia({ reducedMotion: "reduce" });
  await openSettings(dark);
  await expectStyled(dark, "dark");
  await dark.getByRole("button", { name: "Tools", exact: true }).click();
  await dark.getByRole("option", { name: "Output Limits", exact: true }).click();
  await expect(dark.getByRole("heading", { name: "Output Limits", exact: true })).toBeVisible();
  await expect(dark.getByText("Artifact Spill Threshold (KB)", { exact: true })).toBeVisible();
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "s3-cc4-settings-dark.png"), fullPage: true });

  await dark.setViewportSize({ width: 390, height: 844 });
  await expectStyled(dark, "dark");
  await expectNoHorizontalOverflow(dark, "dark, 390 px");
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "s3-cc4-settings-narrow.png"), fullPage: true });

  // A 200% zoom of a 1280 px window lays the page out at 640 CSS px. (CSS `zoom` on the page is no stand-in: at 390 px it
  // made the dialog wider than the window and cut it off at both sides, which a scroll width does not report.)
  await dark.setViewportSize({ width: 640, height: 480 });
  await expectNoHorizontalOverflow(dark, "dark, 640 px (200% zoom of a 1280 px window)");
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "s3-cc4-settings-zoom.png"), fullPage: true });
  expect(realApp.problems).toEqual([]);
});
