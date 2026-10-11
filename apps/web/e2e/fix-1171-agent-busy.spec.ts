/// <reference types="node" />
import { mkdir } from "node:fs/promises";
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
 * #1171. The page misses the events of the turn it started, so it is idle to itself while omp is still busy with
 * that turn. The turn here is an open question (the fake model's ask_user): omp stays busy until it is answered, and
 * the page never sees it. The page's composer then sends a new prompt, which omp refuses ("Agent is already processing
 * ..."). The refusal itself reaches the page as it does in the app.
 */
const QUESTION_TURN = "Please ask_user which database to use.";

interface Frames {
  readonly lines: string[];
  readonly promptIds: string[];
}

/** Hides every event of the first turn from the page until the second prompt goes out; every frame is logged. */
async function hideFirstTurn(page: Page, frames: Frames): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const text = String(message);
      const frame = JSON.parse(text) as Record<string, unknown>;
      frames.lines.push(`out ${text}`);
      if (frame.type === "call" && frame.method === "send") {
        const args = (frame.args ?? {}) as { command?: { type?: string } };
        if (args.command?.type === "prompt") frames.promptIds.push(String(frame.id));
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const text = String(message);
      const frame = JSON.parse(text) as Record<string, unknown>;
      const hidden = frame.type === "event" && frames.promptIds.length === 1;
      frames.lines.push(`in${hidden ? " (hidden)" : ""} ${text}`);
      if (!hidden) ws.send(message);
    });
  });
}

/** The call id of the first prompt sent with the given delivery, or undefined before it is sent. */
function callSentAs(frames: Frames, delivery: "followUp" | "steer"): string | undefined {
  const line = frames.lines.find(
    (entry) => entry.startsWith("out ") && entry.includes(`"streamingBehavior":"${delivery}"`),
  );
  return line === undefined ? undefined : /"id":"([^"]+)"/.exec(line)?.[1];
}

/** Sends the open question, waits until omp admits it, then sends a second prompt that omp refuses as busy. */
async function refusedSecondPrompt(page: Page, composer: Locator, frames: Frames): Promise<void> {
  await sendPrompt(composer, QUESTION_TURN);
  const firstId = frames.promptIds[0] ?? "";
  await expect
    .poll(() =>
      frames.lines.some((line) => line.startsWith("in ") && line.includes(`"id":"${firstId}"`)),
    )
    .toBe(true);
  await sendPrompt(composer, "hi");
  await expect(page.getByText("omp is still working on something.")).toBeVisible({
    timeout: 60_000,
  });
}

realTest.setTimeout(420_000);

realTest(
  "a prompt refused because omp is still busy reads as plain words, keeps the text, and sets no thread error",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const frames: Frames = { lines: [], promptIds: [] };
    const page = await realApp.open({ beforeLoad: (page) => hideFirstTurn(page, frames) });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await refusedSecondPrompt(page, composer, frames);

    // No thread error: the refusal belongs to the prompt that asked, and the chat stays as it was.
    await expect(page.getByText("The conversation could not continue.")).toHaveCount(0);
    await expect(composer).toHaveValue("hi");
    const queue = page.getByRole("button", { name: "Queue it for after" });
    await expect(queue).toBeVisible();
    await expect(page.getByRole("button", { name: "Interrupt and send" })).toBeVisible();

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1171-busy-light.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1171-busy-dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1171-busy-narrow.png"), fullPage: true });

    // Queue it for after: omp takes the text as a follow-up, and the composer lets go of it.
    await queue.click();
    await expect.poll(() => callSentAs(frames, "followUp") !== undefined).toBe(true);
    const callId = callSentAs(frames, "followUp") ?? "";
    await expect
      .poll(() =>
        frames.lines.some(
          (line) =>
            line.startsWith("in ") &&
            line.includes(`"id":"${callId}"`) &&
            line.includes('"ok":true'),
        ),
      )
      .toBe(true);
    await expect(composer).toHaveValue("");
    await expect(queue).toHaveCount(0);
  },
);

realTest("Interrupt and send sends the same text as a steer", async ({ realApp }) => {
  const frames: Frames = { lines: [], promptIds: [] };
  const page = await realApp.open({ beforeLoad: (page) => hideFirstTurn(page, frames) });
  const composer = await startChat(page);
  await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
  await refusedSecondPrompt(page, composer, frames);

  await page.getByRole("button", { name: "Interrupt and send" }).click();
  await expect.poll(() => callSentAs(frames, "steer") !== undefined).toBe(true);
  const callId = callSentAs(frames, "steer") ?? "";
  await expect
    .poll(() =>
      frames.lines.some(
        (line) =>
          line.startsWith("in ") && line.includes(`"id":"${callId}"`) && line.includes('"ok":true'),
      ),
    )
    .toBe(true);
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Interrupt and send" })).toHaveCount(0);
});
