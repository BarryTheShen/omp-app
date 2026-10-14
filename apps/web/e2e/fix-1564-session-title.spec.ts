import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * #1564: a chat whose first message holds a pasted block, sent as omp's wrapped block, is listed in the Sessions list under
 * the first message's typed words. The wrapper omp adds around the paste is never shown in the list.
 */
const LARGE = Array.from({ length: 150 }, (_, index) => `pasted line ${index + 1}`).join("\n");
const CHIP = "Pasted text 1 (150 lines).txt";
const TYPED = "Summarize this";

/** Pastes plain text into the composer, the way a clipboard paste arrives in the browser. */
async function paste(composer: Locator, text: string): Promise<void> {
  await composer.evaluate((input, pasted) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", pasted);
    input.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer }),
    );
  }, text);
}
/** Sends a wrapped paste with a typed line, and waits for omp's reply. */
async function sendWrappedPaste(page: Page, composer: Locator): Promise<void> {
  await paste(composer, LARGE);
  await page.getByRole("button", { name: "Attach as a wrapped block" }).click();
  await expect(page.locator('[data-slot="u2-composer-attachments"]').getByText(CHIP)).toBeVisible();
  await composer.fill(TYPED);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
}

/** The Sessions list row for a chat, found by the words the list shows for it. */
function listRow(page: Page, words: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(words) });
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "#1564 real omp: a chat whose first message holds a wrapped paste is listed under its typed words, in light and dark, with no wrapper",
  async ({ realApp }: { readonly realApp: RealApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendWrappedPaste(page, composer);

    const row = listRow(page, TYPED);
    await expect(row).toBeVisible({ timeout: 45_000 });
    await expect(row).not.toContainText("attachment");
    await expect(row).not.toContainText("pasted line");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1564-list-light.png"),
    });

    await setTheme(page, true);
    await expect(row).not.toContainText("attachment");
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1564-list-dark.png"),
    });

    // At 390 px the list is in the sessions drawer, and the row shows the same words in light.
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    const showSidebar = page.getByRole("button", { name: "Show sessions sidebar" });
    await expect(showSidebar).toBeVisible();
    await showSidebar.click();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("attachment");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1564-list-narrow.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);
