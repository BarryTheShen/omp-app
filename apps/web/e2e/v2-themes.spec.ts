import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Themes (#2767) on real omp: every theme as a picture in Settings → App, a preview while pointing at one, a click
 * that keeps it through a reload, the switch's Light and Dark as your themes, and the palette's theme rows. Code in a
 * reply and in the Files editor is in the chosen theme's own code colours (#2801).
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

  realTest(
    "each theme's picture is drawn in that theme's own colours, its message box's button too, whatever theme the app shows (#2801)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dark = app(page).getByRole("region", { name: "Dark themes" });
      await expect.poll(() => shown(page)).toEqual({ theme: "tern-dark", dark: true });
      // The picture's send button, in the theme's accent fill (themes.css), not the chosen theme's.
      const fill = (name: string) =>
        dark
          .getByRole("button", { name })
          .locator(".bg-primary")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(await fill("Dracula")).toBe("rgb(140, 98, 195)");
      expect(await fill("Gruvbox Dark")).toBe("rgb(91, 124, 112)");
      expect(await fill("Tern Dark")).toBe("rgb(42, 95, 224)");
      // Its line of code starts with a keyword, in the theme's keyword colour.
      const keyword = (name: string) =>
        dark
          .getByRole("button", { name })
          .locator('[class~="bg-(--syn-keyword)"]')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(await keyword("Dracula")).toBe("rgb(255, 121, 198)");
      expect(await keyword("Tern Dark")).toBe("rgb(255, 123, 114)");
      expect(realApp.problems).toEqual([]);
    },
  );

  /** A new chat, ready for a message. */
  async function newChat(page: Page): Promise<void> {
    await startNewChat(page);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      { timeout: 120_000 },
    );
  }

  realTest(
    "code in a reply is in the theme's own code colours, and choosing a theme recolours it (#2801)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("stream_code");
      await box.press("Enter");
      const block = page.locator("pre").filter({ hasText: "export const answer" });
      await expect(block).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 60_000 });
      const keyword = block.locator(".hljs-keyword", { hasText: /^export$/ }).first();
      const number = block.locator(".hljs-number").first();
      const name = block.locator(".hljs-title", { hasText: /^sum$/ }).first();
      // Tern Dark's code colours are GitHub's.
      await expect(keyword).toHaveCSS("color", "rgb(255, 123, 114)");
      await expect(number).toHaveCSS("color", "rgb(121, 192, 255)");

      await page.keyboard.press("Control+k");
      const search = page
        .getByRole("dialog", { name: "Palette", exact: true })
        .getByRole("combobox", { name: "Search the palette" });
      await search.fill("Theme: Dracula");
      await search.press("Enter");
      await expect.poll(() => shown(page)).toEqual({ theme: "dracula", dark: true });
      // Dracula's own: pink keywords, purple numbers, green function names.
      await expect(keyword).toHaveCSS("color", "rgb(255, 121, 198)");
      await expect(number).toHaveCSS("color", "rgb(189, 147, 249)");
      await expect(name).toHaveCSS("color", "rgb(80, 250, 123)");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the Files editor shows code in the theme's own code colours (#2801)",
    async ({ realApp }) => {
      await writeFile(join(realApp.folder, "total.ts"), "const total = 1;\n");
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await page
        .getByRole("tree", { name: "Files" })
        .getByRole("treeitem", { name: "total.ts", exact: true })
        .click();
      const code = page.locator(".cm-content");
      await expect(code).toContainText("const total = 1;");
      // Tern Dark's code colours are GitHub's: a red keyword and a blue number.
      await expect(code.locator("span", { hasText: /^const$/ })).toHaveCSS(
        "color",
        "rgb(255, 123, 114)",
      );
      await expect(code.locator("span", { hasText: /^1$/ })).toHaveCSS(
        "color",
        "rgb(121, 192, 255)",
      );
      expect(realApp.problems).toEqual([]);
    },
  );
});
