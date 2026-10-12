/// <reference types="node" />
import type { Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/**
 * Ctrl+R, Ctrl+G and Ctrl+U act only while the message box has focus (issue 1215). With focus in the sidebar search, the
 * page must leave the key alone, so the browser keeps it; in the message box the app acts and prevents the key. A keydown
 * listener records whether the default was prevented, after the app's own listeners have run.
 */

realTest.setTimeout(420_000);

async function recordPrevented(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.addEventListener("keydown", (event) => {
      document.documentElement.dataset.keyPrevented = String(event.defaultPrevented);
    });
  });
}

realTest(
  "Ctrl+R: the sidebar search leaves the key to the browser, and the message box opens the search",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await recordPrevented(page);
    await page.getByPlaceholder("Search sessions").focus();
    await page.keyboard.press("Control+r");
    await expect(page.locator("html")).toHaveAttribute("data-key-prevented", "false");
    await expect(page.getByRole("dialog", { name: "Search earlier messages" })).toHaveCount(0);
    await composer.focus();
    await page.keyboard.press("Control+r");
    await expect(page.locator("html")).toHaveAttribute("data-key-prevented", "true");
    await expect(page.getByRole("dialog", { name: "Search earlier messages" })).toBeVisible();
  },
);

realTest(
  "Ctrl+G: the sidebar search leaves the key to the browser, and the message box opens the editor",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await recordPrevented(page);
    await page.getByPlaceholder("Search sessions").focus();
    await page.keyboard.press("Control+g");
    await expect(page.locator("html")).toHaveAttribute("data-key-prevented", "false");
    await expect(page.getByRole("dialog", { name: "Edit message" })).toHaveCount(0);
    await composer.focus();
    await page.keyboard.press("Control+g");
    await expect(page.locator("html")).toHaveAttribute("data-key-prevented", "true");
    await expect(page.getByRole("dialog", { name: "Edit message" })).toBeVisible();
  },
);

realTest(
  "Ctrl+U: the sidebar search leaves the key to the browser, and the message box deletes to the line start",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await recordPrevented(page);
    await page.getByPlaceholder("Search sessions").focus();
    await page.keyboard.press("Control+u");
    await expect(page.locator("html")).toHaveAttribute("data-key-prevented", "false");
    await composer.fill("hello world");
    await composer.press("End");
    await composer.press("Control+u");
    await expect(page.locator("html")).toHaveAttribute("data-key-prevented", "true");
    await expect(composer).toHaveValue("");
  },
);
