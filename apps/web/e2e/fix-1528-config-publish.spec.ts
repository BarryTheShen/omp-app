import type { Locator, Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/*
 * Issue 1528: a value saved in Settings on one page did not reach a chat open on another page of the same folder.
 * One page saves Large Paste Menu = 0 in Settings; the other page never opens Settings and must stop offering the
 * paste choice for a 150-line paste (it offers it at the default 100).
 */

const CHOICE = /Where should they go\?/;

/** A text of `count` lines, as a clipboard delivers it. */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

/** Dispatches a paste event that carries `text`, the way the clipboard does. */
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
 * Pastes 150 lines until the choice is offered (`offered`) or is not, as the setting now says. A paste that opens a
 * choice while none is expected is put inline and tried again, so a setting that has not arrived yet is waited for.
 */
async function pasteUntilOffered(page: Page, composer: Locator, offered: boolean): Promise<void> {
  await expect(async () => {
    await composer.fill("");
    await paste(composer, lines(150));
    const choice = page.getByText(CHOICE);
    if (offered) {
      await expect(choice).toBeVisible({ timeout: 1_000 });
      return;
    }
    if (await choice.isVisible()) {
      await page.getByRole("button", { name: "Paste inline" }).click();
      throw new Error("the choice is still offered");
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
  await expect(dialog.getByText("Applied", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

realTest(
  "a value saved in Settings on one page reaches a chat open on another page that never opens Settings (issue 1528)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const observer = await realApp.open();
    const observerComposer = await startChat(observer);
    await pasteUntilOffered(observer, observerComposer, true);
    await observer.getByRole("button", { name: "Paste inline" }).click();
    await observerComposer.fill("");

    const writer = await realApp.open();
    await startChat(writer);
    await setLargePasteMenu(writer, 0);

    // The observer page has never opened Settings: the new value must reach its open chat by itself.
    await pasteUntilOffered(observer, observerComposer, false);
    expect(realApp.problems).toEqual([]);
  },
);
