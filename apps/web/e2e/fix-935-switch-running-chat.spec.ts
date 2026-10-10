import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);
realTest.use({ seedSessions: 3 });

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/**
 * Issue #935. A chat whose turn is still running when the person switches to another chat keeps its row in the list
 * once the turn ends, and its answer is there when they go back.
 */
realTest(
  "a chat switched away from mid-turn gets its row when the turn ends, and its answer when you go back",
  async ({ realApp }) => {
    const page = await realApp.open();
    const running = await startChat(page);
    await sendPrompt(running, "slow_tool switch");
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });

    await sessionList(page)
      .getByRole("option", { name: /Seeded chat 3/ })
      .click();
    await expect(transcript(page).getByText("Seeded chat 3", { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // The turn ends while another chat is open: the list gets the row the running chat wrote.
    await expect(sessionList(page).getByRole("option", { name: /slow_tool switch/ })).toHaveCount(
      1,
      { timeout: 60_000 },
    );

    // Going back shows the chat with its finished turn.
    await sessionList(page)
      .getByRole("option", { name: /slow_tool switch/ })
      .click();
    await expect(transcript(page).getByText("slow_tool switch", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 60_000,
    });
  },
);
