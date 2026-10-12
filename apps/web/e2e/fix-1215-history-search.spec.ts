/// <reference types="node" />
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Ctrl+R searches the messages you sent earlier (omp's app.history.search; issue 1215). The dialog lists them newest
 * first, typing words narrows the list, Enter puts the chosen message in the message box in place of its text, and
 * Escape closes the dialog and keeps the box as it was. The fake model answers every message with "pong".
 */

const DIALOG = "Search earlier messages";
const SEARCH = "Type words to search";
const EMPTY = "You have not sent any messages yet.";

realTest.setTimeout(420_000);

function searchDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: DIALOG });
}

/** Sends one message and waits for its reply (the nth "pong") and for the turn to end, so the next send is not a steer. */
async function sendAndWait(
  page: Page,
  composer: Locator,
  text: string,
  reply: number,
): Promise<void> {
  await sendPrompt(composer, text);
  await expect(page.getByText("pong", { exact: true })).toHaveCount(reply, { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 120_000,
  });
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest(
  "Ctrl+R with no earlier messages says so in plain words, and Escape leaves the box as it was",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("keep me");
    await composer.press("Control+r");
    await expect(searchDialog(page)).toBeVisible();
    await expect(searchDialog(page).getByText(EMPTY)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(searchDialog(page)).toBeHidden();
    await expect(composer).toHaveValue("keep me");
  },
);

realTest(
  "Ctrl+R lists earlier messages newest first; typing narrows them; Enter puts the chosen one in the box",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendAndWait(page, composer, "first alpha note", 1);
    await sendAndWait(page, composer, "second beta note", 2);
    await sendAndWait(page, composer, "third gamma note", 3);
    await composer.fill("typed over");
    await composer.press("Control+r");

    const dialog = searchDialog(page);
    await expect(dialog).toBeVisible();
    const rows = dialog.getByRole("option");
    await expect(rows).toHaveText(["third gamma note", "second beta note", "first alpha note"]);
    // Captured with the whole list showing: light, then a 390 px phone width.
    await settle(page);
    await page.screenshot({ path: join(screenshots, "history-search-light.png"), fullPage: true });
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "history-search-narrow.png"),
      fullPage: true,
    });
    if (desktop) await page.setViewportSize(desktop);

    await dialog.getByRole("searchbox", { name: SEARCH }).fill("beta");
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveText(["second beta note"]);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(composer).toHaveValue("second beta note");
  },
);

realTest("the search is readable in dark mode", async ({ realApp }) => {
  // The saved theme is set before the page loads, the way a person who chose Dark gets it.
  const page = await realApp.open({
    beforeLoad: (openPage) =>
      openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await sendAndWait(page, composer, "dark alpha note", 1);
  await composer.press("Control+r");
  const dialog = searchDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(dialog.getByRole("option")).toHaveText(["dark alpha note"]);
  await settle(page);
  await page.screenshot({ path: join(screenshots, "history-search-dark.png"), fullPage: true });
});
