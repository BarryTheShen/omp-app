import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1305: searching the command palette for "refresh" found no command, because the reconnect command was titled
 * "Fresh connection to the model". Its title now says what it does, so "refresh" finds it; its `/fresh` slash name
 * stays. Captures: light, dark and 390 px wide.
 */

const RECONNECT = /Refresh model connection/;

/** Sets the colour scheme the way the browser does (the app follows System by default), then waits for the theme. */
async function setColorScheme(page: Page, dark: boolean): Promise<void> {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", dark ? "dark" : "light");
  await waitForFiniteAnimations(page);
}

async function capture(palette: Locator, name: string): Promise<void> {
  await palette.screenshot({ path: join(screenshots, "fix-1305", `${name}.png`) });
}

realTest(
  "typing refresh in the command palette finds the reconnect command",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1100, height: 900 });
    const composer = await startChat(page);
    await composer.focus();
    await page.keyboard.press("Control+k");

    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox", { name: "Search commands" }).fill("refresh");
    const option = palette.getByRole("option", { name: RECONNECT });
    await expect(option, "refresh finds the reconnect command").toBeVisible({ timeout: 30_000 });
    await expect(option, "the slash name stays /fresh").toContainText("/fresh");
    await expect(palette.getByText("No commands found.")).toHaveCount(0);
    await capture(palette, "light");

    await setColorScheme(page, true);
    await expect(option).toBeVisible();
    await capture(palette, "dark");

    await setColorScheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(option).toBeVisible();
    await capture(palette, "390");
    expect(realApp.problems).toEqual([]);
  },
);
