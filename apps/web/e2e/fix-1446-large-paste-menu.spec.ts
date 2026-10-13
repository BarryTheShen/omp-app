import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1446: the composer ignores Settings > Interaction > Large Paste Menu (omp's paste.largeMenuThreshold). A paste
 * opens the choice when it has at least this many lines, and 0 turns the choice off. Captures: light, dark and 390 px.
 */

const CHOICE = /Where should they go\?/;

/** A text of `count` lines, as a clipboard delivers it. */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

/** Dispatches a paste event that carries `text`, the way the clipboard does. A paste the composer leaves alone is not inserted here. */
async function paste(composer: Locator, text: string): Promise<void> {
  await composer.evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

/**
 * Pastes `text` until the choice is offered (`offered`) or is not, as the setting now says. A paste that opens a choice
 * while none is expected is put inline and tried again, so a setting that has not reached the composer yet is waited for.
 */
async function pasteUntilOffered(
  page: Page,
  composer: Locator,
  text: string,
  offered: boolean,
): Promise<void> {
  await expect(async () => {
    await composer.fill("");
    await paste(composer, text);
    const choice = page.getByText(CHOICE);
    if (offered) {
      await expect(choice).toBeVisible({ timeout: 1_000 });
      return;
    }
    if (await choice.isVisible()) {
      await page.getByRole("button", { name: "Paste inline" }).click();
      throw new Error("a choice is still offered");
    }
  }).toPass({ timeout: 20_000 });
}

/** Sets Settings > Interaction > Large Paste Menu, saves it, and closes the screen. */
async function setLargePasteMenu(page: Page, value: number): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Interaction" }).click();
  const menu = dialog.getByRole("spinbutton", { name: "Large Paste Menu" });
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await menu.fill(String(value));
  await dialog.getByRole("button", { name: "Save changes" }).click();
  // Save changes is disabled while a save runs and after it, so the wait is for what the save leaves on screen:
  // "Applied" shows only once the write has finished. Closing earlier could read the value before the write.
  await expect(dialog.getByText("Applied", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/** Switches the page between light and dark, as the app's theme does, and lets it settle. */
async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "the large-paste choice follows Settings > Large Paste Menu: Off shows none, and a changed value moves it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(join(screenshots, "fix-1446"), { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);

    await setLargePasteMenu(page, 0);
    await pasteUntilOffered(page, composer, lines(150), false);

    await setLargePasteMenu(page, 250);
    await pasteUntilOffered(page, composer, lines(150), false);
    await pasteUntilOffered(page, composer, lines(250), true);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1446", "light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1446", "dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    // Narrowing closes both sidebars as drawers; wait until both report closed before the narrow capture.
    for (const side of ["left", "right"] as const) {
      const sidebar = page.locator(`[data-shell-sidebar="${side}"]`);
      await expect(sidebar).toHaveAttribute("data-open", "false");
      await expect(sidebar).toBeHidden();
    }
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1446", "390.png") });
    await page.getByRole("button", { name: "Paste inline" }).click();
    await expect(composer).toHaveValue(lines(250));
    expect(realApp.problems).toEqual([]);
  },
);
