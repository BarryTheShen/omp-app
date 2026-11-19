import type { Page } from "@playwright/test";
import { expect, realTest, sendPrompt } from "./real-omp";

/**
 * Edit with the chat open in several windows (#22): an Edit moves where omp continues, so every window open on the chat,
 * one opened after it and one reloaded after it show the chat from there, and a message sent from any of them continues
 * from what they show.
 */
realTest.describe("new UI: Edit with several windows on one chat", () => {
  realTest.setTimeout(300_000);
  realTest.use({ seedSessions: 1 });
  const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const message = (page: Page, text: string) => transcript(page).getByText(text, { exact: true });

  async function openChat(page: Page): Promise<void> {
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "Seeded chat 1" })
      .first()
      .click();
    await expect(box(page)).toBeVisible({ timeout: 120_000 });
  }

  /** Sends `text` and waits until its turn is read back from the file (the Edit button needs omp's entry ids). */
  async function send(page: Page, text: string): Promise<void> {
    await sendPrompt(box(page), text);
    await expect(message(page, text)).toBeVisible({ timeout: 120_000 });
    await expect(
      transcript(page)
        .getByText(text, { exact: true })
        .locator('xpath=ancestor::*[.//button[@aria-label="Edit this message"]][1]'),
    ).toHaveCount(1, { timeout: 120_000 });
  }

  async function edit(page: Page, text: string): Promise<void> {
    const row = message(page, text).locator(
      'xpath=ancestor::*[.//button[@aria-label="Edit this message"]][1]',
    );
    await message(page, text).hover();
    await row.getByRole("button", { name: "Edit this message" }).click();
    await expect(box(page)).toHaveValue(text, { timeout: 30_000 });
  }

  /** The window shows the chat up to and with `shown`, and none of `gone`. */
  async function shows(page: Page, shown: readonly string[], gone: readonly string[]) {
    for (const text of shown) await expect(message(page, text)).toBeVisible({ timeout: 30_000 });
    for (const text of gone) await expect(message(page, text)).toHaveCount(0, { timeout: 30_000 });
  }

  async function threeMessages(page: Page): Promise<void> {
    await openChat(page);
    await send(page, "alpha");
    await send(page, "bravo");
    await send(page, "charlie");
  }

  realTest(
    "an Edit shows in every window on the chat and in one opened after it, and the edited message then shows in all",
    async ({ realApp }) => {
      const a = await realApp.open({ path: "/" });
      await threeMessages(a);
      const b = await realApp.open({ path: "/" });
      await openChat(b);
      await shows(b, ["alpha", "bravo", "charlie"], []);

      await edit(a, "bravo");
      await shows(a, ["alpha"], ["bravo", "charlie"]);
      await shows(b, ["alpha"], ["bravo", "charlie"]);
      // The other window's box is its own: the edited text comes back only where Edit was clicked.
      await expect(box(b)).not.toHaveValue("bravo");
      const c = await realApp.open({ path: "/" });
      await openChat(c);
      await shows(c, ["alpha"], ["bravo", "charlie"]);

      await box(a).fill("bravo2");
      await send(a, "bravo2");
      for (const page of [a, b, c]) await shows(page, ["alpha", "bravo2"], ["bravo", "charlie"]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "after an Edit in one window, a message sent from another continues from the Edit, as both show",
    async ({ realApp }) => {
      const a = await realApp.open({ path: "/" });
      await threeMessages(a);
      const b = await realApp.open({ path: "/" });
      await openChat(b);
      await edit(a, "bravo");
      await shows(b, ["alpha"], ["bravo", "charlie"]);

      await send(b, "delta");
      for (const page of [a, b]) await shows(page, ["alpha", "delta"], ["bravo", "charlie"]);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a window reloaded after an Edit shows the chat from the Edit, where its next message continues",
    async ({ realApp }) => {
      const a = await realApp.open({ path: "/" });
      await threeMessages(a);
      await edit(a, "bravo");
      await a.reload();
      await openChat(a).catch(() => undefined);
      await shows(a, ["alpha"], ["bravo", "charlie"]);

      await send(a, "echo");
      await shows(a, ["alpha", "echo"], ["bravo", "charlie"]);
      expect(realApp.problems).toEqual([]);
    },
  );
});
