/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue 1321. Ctrl+R lists the messages you sent, newest first, in a list about seven rows tall. Down moves the
 * highlight, and the list must scroll so the highlighted row stays in view: Enter then puts the message the person
 * can see in the message box. Before the fix, the highlight moved below the bottom of the list and nothing scrolled it back.
 */

const DIALOG = "Search earlier messages";
const NARROW = { width: 390, height: 844 } as const;
const WIDE = { width: 1280, height: 900 } as const;

// Oldest first. The dialog lists them newest first, so "note 01" is the bottom row.
const NOTES = Array.from(
  { length: 10 },
  (_, index) => `note ${String(index + 1).padStart(2, "0")}`,
);
const START = Date.UTC(2026, 9, 10, 10, 0, 0);
const entries = NOTES.map((text, index) => ({
  type: "message",
  message: {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: START + index * 1_000,
  },
}));

realTest.use({ seedEntries: { entries } });
realTest.setTimeout(420_000);

/** Whether a row lies wholly inside the list's visible box, which is what a person can see of the list. */
async function rowShownInList(list: Locator, row: Locator): Promise<boolean> {
  const box = await list.boundingBox();
  const shown = await row.boundingBox();
  if (box === null || shown === null) return false;
  return shown.y >= box.y && shown.y + shown.height <= box.y + box.height;
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest(
  "Down keeps the highlighted message in view, so Enter puts the message you can see in the box",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(WIDE);
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("note 10", { exact: true })).toBeVisible({ timeout: 60_000 });
    const composer = page.getByRole("textbox", { name: "Message input" });
    await composer.click();
    await composer.press("Control+r");

    const dialog = page.getByRole("dialog", { name: DIALOG });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("option")).toHaveText([...NOTES].reverse());
    const list = dialog.getByRole("listbox");
    for (let step = 0; step < NOTES.length - 1; step += 1) await page.keyboard.press("ArrowDown");

    const highlighted = dialog.getByRole("option", { selected: true });
    await expect(highlighted).toHaveText("note 01");
    await expect.poll(() => rowShownInList(list, highlighted)).toBe(true);

    await mkdir(screenshots, { recursive: true });
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-1321-history-light.png"),
      fullPage: true,
    });

    await page.setViewportSize(NARROW);
    await expect.poll(() => rowShownInList(list, highlighted)).toBe(true);
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-1321-history-narrow.png"),
      fullPage: true,
    });

    await page.setViewportSize(WIDE);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect.poll(() => rowShownInList(list, highlighted)).toBe(true);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1321-history-dark.png"), fullPage: true });

    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(composer).toHaveValue("note 01");
    expect(realApp.problems).toEqual([]);
  },
);
