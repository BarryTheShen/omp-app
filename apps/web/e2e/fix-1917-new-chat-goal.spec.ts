import { expect, realTest, sendPrompt, startChat } from "./real-omp";

// Each chat is its own omp process, so a goal never moves to the next chat; what stayed was the header notice of the
// `/goal` command, held in the page's state across the switch. A first prompt makes each chat live before its command
// (a command typed into a chat that is not live yet can be ignored, #1959), and "No messages yet." can only mean the
// new chat is on screen, because the first chat has a message.
realTest(
  "a new chat starts without the previous chat's goal notice and sets its own goal",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "count_reply first");
    await expect(page.getByText(/^count-\d+ first$/)).toBeVisible({ timeout: 60_000 });
    await sendPrompt(composer, "/goal stable-goal");
    await expect(page.getByText("Goal set: stable-goal. Status: Active.")).toBeVisible({
      timeout: 60_000,
    });

    await page
      .locator('[aria-label="Sessions"]')
      .getByRole("button", { name: "New chat" })
      .first()
      .click();
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });
    // The notice goes when the new chat opens, not when its own 8-second timer runs out, so the wait is short.
    await expect(page.getByText("Goal set: stable-goal. Status: Active.")).toHaveCount(0, {
      timeout: 2_000,
    });

    await sendPrompt(composer, "count_reply second");
    await expect(page.getByText(/^count-\d+ second$/)).toBeVisible({ timeout: 60_000 });
    await sendPrompt(composer, "/goal fresh-goal");
    await expect(page.getByText("Goal set: fresh-goal. Status: Active.")).toBeVisible({
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);
