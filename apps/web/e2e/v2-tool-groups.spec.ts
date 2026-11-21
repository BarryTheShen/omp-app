import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Runs of tool calls (Settings → App → Look → Group tool calls, on by default): a saved run is one card that names how
 * many calls and which tools, and opens to the calls themselves; a run being made is one card that shows the call
 * running now and grows; with the setting off, each call is its own card again.
 */
realTest.describe("new UI: grouped tool calls", () => {
  realTest.use({ seedSessions: 1, seedLongTurn: 3 });

  realTest(
    "a saved run is one card that opens to its calls, and the setting turns it back into one card per call",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      const page = await realApp.open({ path: "/" });
      const transcript = page.getByRole("region", { name: "Transcript" });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Run the long job" })
        .click();
      await expect(transcript.getByText("All 3 steps are done.")).toBeVisible({ timeout: 60_000 });

      const group = transcript.getByRole("button", { name: /^3 tool calls/ });
      await expect(group).toBeVisible();
      await expect(group).toContainText("bash 3");
      await expect(group).toHaveAttribute("aria-expanded", "false");
      await expect(transcript.getByText("echo step-0")).toHaveCount(0);
      // Your message, the group and the answer: the calls take one line between them.
      await expect(transcript.locator(".tv-card")).toHaveCount(1);

      await group.click();
      await expect(group).toHaveAttribute("aria-expanded", "true");
      for (const step of [0, 1, 2])
        await expect(transcript.getByText(`echo step-${step}`)).toBeVisible();
      await expect(transcript.locator(".tv-card")).toHaveCount(4);

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator('[data-tour="settings-tab-app"]').click();
      const setting = page.getByRole("switch", { name: "Group tool calls" });
      await expect(setting).toBeChecked();
      await setting.click();
      await expect(setting).not.toBeChecked();
      await page.keyboard.press("Escape");
      await expect(transcript.getByRole("button", { name: /tool calls/ })).toHaveCount(0);
      await expect(transcript.locator(".tv-card")).toHaveCount(3);

      // The choice is kept in this browser.
      await page.reload();
      await expect(transcript.getByText("All 3 steps are done.")).toBeVisible({ timeout: 60_000 });
      await expect(transcript.locator(".tv-card")).toHaveCount(3);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a run being made is one card that shows the call running now and grows",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({ path: "/" });
      const transcript = page.getByRole("region", { name: "Transcript" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("long_loop");
      await box.press("Enter");

      const group = transcript.getByRole("button", { name: /tool calls/ });
      await expect(group).toHaveCount(1, { timeout: 60_000 });
      await expect(group.getByRole("img", { name: "running" })).toBeVisible({ timeout: 30_000 });
      await expect(group).toContainText(/sleep 0\.2; echo loop-\d+|bash/);
      const count = async () =>
        Number(/^(\d+) tool calls/.exec((await group.textContent()) ?? "")?.[1] ?? 0);
      const early = await count();
      await expect.poll(count, { timeout: 60_000 }).toBeGreaterThan(early + 3);

      await expect(transcript.getByText("loop finished")).toBeVisible({ timeout: 120_000 });
      await expect(group).toHaveCount(1);
      await expect(group).toContainText(/^60 tool calls/);
      await expect(group).toContainText("bash 60");
      await expect(group.getByRole("img", { name: "running" })).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});

/** A saved turn as omp writes it: the person's message, then lead-ins and calls with their results, then the answer. */
const AT = Date.UTC(2026, 10, 21, 9);
const STAMP = new Date(AT).toISOString();
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const reply = (id: string, n: number, content: unknown[], stopReason = "toolUse") => ({
  type: "message",
  id,
  parentId: null,
  timestamp: STAMP,
  message: {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage: USAGE,
    stopReason,
    timestamp: AT + n,
  },
});
const ran = (id: string, n: number, callId: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: STAMP,
  message: {
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: AT + n,
  },
});
const bash = (id: string, command: string) => ({
  type: "toolCall",
  id,
  name: "bash",
  arguments: { command },
});

realTest.describe("new UI: grouped tool calls with the lines between them", () => {
  realTest.use({
    seedEntries: {
      entries: [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: STAMP,
          message: {
            role: "user",
            content: [{ type: "text", text: "Why is the queue slow?" }],
            timestamp: AT,
          },
        },
        reply("a1", 1, [
          { type: "text", text: "Checking the queue first:" },
          bash("c1", "gq status"),
        ]),
        ran("r1", 2, "c1", "2 running"),
        reply("a2", 3, [{ type: "text", text: "Reading the `gq` log:" }, bash("c2", "gq tail")]),
        ran("r2", 4, "c2", "slot 3 waits on disk"),
        reply("a3", 5, [{ type: "text", text: "Slot 3 waits on the disk." }], "stop"),
      ],
    },
  });

  realTest(
    "a one-line lead-in joins the group and titles it; the answer stays in view; opened, the lead-ins show between the calls",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(120_000);
      const page = await realApp.open({ path: "/" });
      const transcript = page.getByRole("region", { name: "Transcript" });
      await page.getByText("Why is the queue slow?").first().click();
      await expect(transcript.getByText("Slot 3 waits on the disk.")).toBeVisible({
        timeout: 60_000,
      });

      const group = transcript.getByRole("button", { name: /^2 tool calls/ });
      await expect(group).toContainText("Reading the gq log");
      await expect(transcript.getByText("Checking the queue first:")).toHaveCount(0);
      await expect(transcript.locator(".tv-card")).toHaveCount(1);

      await group.click();
      await expect(transcript.getByText("Checking the queue first:")).toBeVisible();
      await expect(transcript.getByText("gq status")).toBeVisible();
      await expect(transcript.getByText("gq tail")).toBeVisible();
      expect(realApp.problems).toEqual([]);
    },
  );
});
