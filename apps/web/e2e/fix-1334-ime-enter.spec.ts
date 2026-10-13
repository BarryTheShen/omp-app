/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue 1334. While an input method (IME) composes a word, Enter and the arrow keys belong to the IME. The Enter that
 * commits a composed word must not choose the highlighted row: in the message box it must not insert the highlighted
 * emoji, and in the command palette it must not run the highlighted command. Playwright cannot drive an IME, so the
 * composing keydown is dispatched the way a browser sends it (isComposing true, or keyCode 229 for the Enter Safari
 * sends after the composition ends); the app around it is real.
 */

/** The keys an input method sends while it composes a word: the composing flag, or keyCode 229 (Safari's commit Enter). */
interface ComposingKey {
  readonly key: string;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** Dispatches a keydown on an element the way an input method sends a key while it composes a word. */
async function composingKey(target: Locator, key: ComposingKey): Promise<void> {
  await target.evaluate((element, detail) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { ...detail, bubbles: true, cancelable: true }),
    );
  }, key);
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest.setTimeout(420_000);

realTest(
  "an Enter that commits an IME word does not insert the highlighted emoji; a real Enter does",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill(":smi");
    const emojis = page.getByRole("listbox", { name: "Emoji suggestions" }).getByRole("option");
    await expect(emojis.first()).toBeVisible({ timeout: 30_000 });

    // An input method's arrow key must leave the highlight on the first emoji too: a real Enter below inserts that one.
    await composingKey(composer, { key: "ArrowDown", isComposing: true });
    await composingKey(composer, { key: "Enter", isComposing: true });
    await composingKey(composer, { key: "Enter", keyCode: 229 });
    await expect(composer).toHaveValue(":smi");
    await expect(emojis.first()).toBeVisible();

    await mkdir(screenshots, { recursive: true });
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-1334-composer-light.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(emojis.first()).toBeVisible();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-1334-composer-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect(emojis.first()).toBeVisible();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-1334-composer-dark.png"),
      fullPage: true,
    });

    await composer.press("Enter");
    await expect(composer).toHaveValue(/😄/);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "an Enter that commits an IME word leaves the command palette open; a real Enter runs the command",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    const search = page.getByRole("combobox", { name: "Search commands" });
    await search.fill("new chat");

    await composingKey(search, { key: "Enter", isComposing: true });
    await composingKey(search, { key: "Enter", keyCode: 229 });
    await expect(dialog).toBeVisible();
    await expect(search).toBeEnabled();
    await expect(search).toHaveValue("new chat");

    await page.keyboard.press("Enter");
    // "New chat" starts a real omp, and the palette closes only once the chat has started: wait for that state.
    await expect(dialog).toBeHidden({ timeout: 120_000 });
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
      timeout: 30_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);
