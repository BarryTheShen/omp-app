import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * the owner's feedback #662: 'Cannot find darkmode button.' The theme control lives at the bottom of the
 * left sidebar: Light, Dark and System (the default), remembered across reloads. This is the real
 * app: the theme is read from the saved choice and the browser's own setting.
 */

async function shellBackground(page: Page): Promise<string> {
  return page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
}

function lightness(color: string): number {
  // oklch(L ...) or rgb(r, g, b): enough to tell a dark surface from a light one.
  const oklch = color.match(/oklch\(\s*([\d.]+)/);
  if (oklch?.[1] !== undefined) return Number.parseFloat(oklch[1]);
  const rgb = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) return (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / (3 * 255);
  throw new Error(`cannot read the lightness of ${color}`);
}

realTest(
  "System follows the browser live, Light and Dark stick across a reload, and the choice is one click in the sidebar",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const group = page.getByRole("radiogroup", { name: "Theme" });

    // No choice made: System, which is the browser's dark here.
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio", { name: "System" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(lightness(await shellBackground(page))).toBeLessThan(0.4);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "theme-dark-1280.png") });

    // The browser's setting changes: the page follows without a reload.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(lightness(await shellBackground(page))).toBeGreaterThan(0.8);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "theme-light-1280.png") });

    // Dark, chosen: it holds against a light browser, and across a reload.
    await group.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("[data-app-root='true']")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    // Light, chosen: the same against a dark browser.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("[data-app-root='true']")).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(lightness(await shellBackground(page))).toBeGreaterThan(0.8);

    // And back to System, which forgets the choice and follows the browser again.
    await page.getByRole("radio", { name: "System" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Phone width: the sidebar opens over the page, and the control is in it, in both themes.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /Show sessions sidebar/i }).click();
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "theme-dark-390.png") });
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "theme-light-390.png") });
  },
);

realTest(
  "a dark browser never flashes light: the saved or system theme is on the page before the app code runs",
  async ({ realApp }) => {
    // With the app's own scripts blocked, only the small script in the page itself can set the theme.
    realApp.allowProblem(/Failed to load resource|net::ERR_/);
    const bare = await realApp.open({
      expectApp: false,
      beforeLoad: async (target) => {
        await target.emulateMedia({ colorScheme: "dark" });
        await target.route("**/assets/**/*.js", (route) => route.abort());
      },
    });
    await expect(bare.locator("html")).toHaveClass(/dark/);
    expect(await bare.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
    // A saved Light beats the dark browser, with the app still blocked.
    await bare.evaluate(() => window.localStorage.setItem("omp-app.theme", "light"));
    await bare.reload();
    await expect(bare.locator("html")).not.toHaveClass(/dark/);
  },
);
