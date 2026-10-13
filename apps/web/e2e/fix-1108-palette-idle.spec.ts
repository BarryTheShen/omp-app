import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/** Lets finite transitions settle before a screenshot. Bounded, so a transition that never ends cannot hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

realTest(
  "#1108: with no chat open, Ctrl+K opens the palette, and New chat from it starts a chat (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(page.getByText("Open a session to start composing.")).toBeVisible({
      timeout: 60_000,
    });
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const newChat = palette.getByRole("option", { name: /^New chat/ });

    // Light: no chat is open, and the palette still opens with New chat in it.
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible();
    await expect(newChat).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1108-palette-light.png") });
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);

    // Dark theme, the same palette.
    await setTheme(page, true);
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1108-palette-dark.png") });
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);

    // 390 px, light again.
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Control+k");
    await expect(palette).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1108-palette-narrow.png") });

    // New chat from the palette starts a chat. The palette closes once that chat has started, which waits for omp, so
    // the palette wait is bounded like the message box wait below (a 5 s default failed under load, before omp started).
    await newChat.click();
    await expect(palette).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
      timeout: 120_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);
