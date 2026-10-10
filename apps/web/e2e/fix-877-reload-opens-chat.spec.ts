import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

function newChatButton(page: Page): Locator {
  return page.locator('[aria-label="Sessions"]').getByRole("button", { name: "New chat" }).first();
}

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

/**
 * Issue #877. A new chat can finish opening after the person has picked a listed chat. The listed chat must stay
 * open: its draft stays in the composer, and a reload opens it again with that draft.
 */
realTest(
  "a chat picked right after New chat stays open, and a reload opens it with its draft",
  async ({ realApp }) => {
    const page = await realApp.open();
    const first = await startChat(page);
    await sendPrompt(first, "draft host three");
    await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });

    // Both clicks come before the new chat has finished opening, as a person makes them.
    await newChatButton(page).click();
    await sessionList(page)
      .getByRole("option", { name: /draft host three/ })
      .click();
    await expect(transcript(page).getByText("draft host three", { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    await composer(page).fill("draft D3 text");
    // The new chat's omp can finish starting seconds later. Wait past that: the picked chat must still be open.
    await page.waitForTimeout(12_000);
    await expect(transcript(page).getByText("draft host three", { exact: true })).toBeVisible();
    await expect(composer(page)).toHaveValue("draft D3 text");

    await page.reload();

    await expect(transcript(page).getByText("draft host three", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(composer(page)).toHaveValue("draft D3 text", { timeout: 30_000 });
    await expect(
      sessionList(page).getByRole("option", { name: /draft host three/, selected: true }),
    ).toHaveCount(1);
  },
);
