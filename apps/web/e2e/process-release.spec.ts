import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/**
 * Every chat that was ever opened used to keep its own omp process (about 380 MB) until the app
 * quit (feedback #665). An unwatched chat's process now stops after the idle time, so these tests
 * shorten it to 1.5 s and watch the real processes of the server.
 */
realTest.use({ idleCloseMs: 1_500 });

const assistantReplies = (page: import("@playwright/test").Page) =>
  page.locator('[data-slot="u1-message-row"][data-role="assistant"]');

realTest(
  "leaving a chat stops its omp process once idle, and the chat opens again afterwards",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "first chat ping");
    await expect(assistantReplies(page).filter({ hasText: "pong" })).toHaveCount(1, {
      timeout: 45_000,
    });
    await expect(page.getByText("Assistant is working…")).toBeHidden({ timeout: 45_000 });
    const running = realApp.ompProcesses();
    expect(running).toHaveLength(1);
    const firstProcess = running[0];
    if (firstProcess === undefined) throw new Error("no omp process is running");

    // A second chat: the first is no longer watched, so its process goes away and the new one stays.
    await startChat(page);
    await expect
      .poll(() => realApp.ompProcesses().includes(firstProcess), { timeout: 30_000 })
      .toBe(false);
    expect(realApp.ompProcesses()).toHaveLength(1);

    // Back in the first chat: its history is there and omp answers again, on a new process.
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option")
      .filter({ hasText: "first chat ping" })
      .click();
    await expect(
      page
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: "first chat ping" }),
    ).toBeVisible({ timeout: 30_000 });
    await sendPrompt(page.getByRole("textbox", { name: "Message input" }), "second ping");
    await expect(assistantReplies(page).filter({ hasText: "pong" })).toHaveCount(2, {
      timeout: 45_000,
    });
    expect(realApp.ompProcesses()).not.toContain(firstProcess);
  },
);

realTest(
  "closing the tab stops the process of an idle chat, but never one that is still working",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    // The fake model answers "slow_tool" with a shell command that takes 7 seconds.
    await sendPrompt(composer, "please run slow_tool for me");
    await expect(page.getByText("Assistant is working…")).toBeVisible({ timeout: 30_000 });
    expect(realApp.ompProcesses()).toHaveLength(1);
    await page.close();

    // Three idle periods pass while the command is still running: the turn must not be cut off.
    await new Promise((done) => setTimeout(done, 4_500));
    expect(realApp.ompProcesses()).toHaveLength(1);

    // Once the command is done and omp is settled, nobody is watching, so the process stops.
    await expect.poll(() => realApp.ompProcesses().length, { timeout: 45_000 }).toBe(0);

    // The finished work is in the session file: a new tab opens the chat with the answer in it.
    const again = await realApp.open();
    await again
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option")
      .filter({ hasText: "slow_tool" })
      .click();
    await expect(again.getByText("tool said: slow-tool-done")).toBeVisible({ timeout: 45_000 });
  },
);
