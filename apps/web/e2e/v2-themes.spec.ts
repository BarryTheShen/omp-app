import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * Themes (#2767) on real omp: every theme as a picture in Settings → App, a preview while pointing at one, a click
 * that keeps it through a reload, the switch's Light and Dark as your themes, and the palette's theme rows.
 */
realTest.describe("themes", () => {
  realTest.setTimeout(240_000);

  /** The theme on screen, and whether Tailwind's `dark` is on. */
  const shown = (page: Page) =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      dark: document.documentElement.classList.contains("dark"),
    }));
  const app = (page: Page) =>
    page.getByRole("dialog", { name: "Settings" }).getByRole("region", { name: "App settings" });

  realTest(
    "Settings → App: pointing at a theme shows it, a click keeps it through a reload, Light is your light theme",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dark = app(page).getByRole("region", { name: "Dark themes" });
      const light = app(page).getByRole("region", { name: "Light themes" });
      await expect(dark.getByRole("button")).toHaveCount(6);
      await expect(light.getByRole("button")).toHaveCount(3);
      await expect(dark.getByRole("button", { name: "Tern Dark" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      const mocha = dark.getByRole("button", { name: "Catppuccin Mocha" });
      await mocha.hover();
      await expect.poll(() => shown(page)).toEqual({ theme: "catppuccin-mocha", dark: true });
      await app(page).getByRole("group", { name: "Theme" }).hover();
      await expect.poll(() => shown(page)).toEqual({ theme: "tern-dark", dark: true });

      await mocha.click();
      await expect.poll(() => shown(page)).toEqual({ theme: "catppuccin-mocha", dark: true });
      await expect(mocha).toHaveAttribute("aria-pressed", "true");
      await page.reload();
      await expect.poll(() => shown(page)).toEqual({ theme: "catppuccin-mocha", dark: true });

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const theme = app(page).getByRole("group", { name: "Theme" });
      await theme.getByRole("button", { name: "Light" }).click();
      await expect.poll(() => shown(page)).toEqual({ theme: "tern-light", dark: false });
      await light.getByRole("button", { name: "Catppuccin Latte" }).click();
      await expect.poll(() => shown(page)).toEqual({ theme: "catppuccin-latte", dark: false });
      await theme.getByRole("button", { name: "Dark" }).click();
      await expect.poll(() => shown(page)).toEqual({ theme: "catppuccin-mocha", dark: true });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the palette lists every theme: a highlighted row shows it, Esc goes back, Enter keeps it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const search = page
        .getByRole("dialog", { name: "Palette", exact: true })
        .getByRole("combobox", { name: "Search the palette" });
      await page.keyboard.press("Control+k");
      await search.fill("Theme: Tokyo Night Storm");
      await expect.poll(() => shown(page)).toEqual({ theme: "tokyo-night-storm", dark: true });
      await search.press("Escape");
      await expect.poll(() => shown(page)).toEqual({ theme: "tern-dark", dark: true });

      await page.keyboard.press("Control+k");
      await search.fill("Theme: Tokyo Night Light");
      await search.press("Enter");
      await expect.poll(() => shown(page)).toEqual({ theme: "tokyo-night-light", dark: false });
      expect(realApp.problems).toEqual([]);
    },
  );
});
