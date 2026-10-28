/// <reference types="node" />
import { randomUUID } from "node:crypto";
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
 * #1171. A test-side request on the app's protocol starts an ask_user turn in this session while the page remains idle. The wire hides the
 * external turn's events, so the page sends a new prompt; omp refuses it as busy and the refusal reaches the page.
 */
const QUESTION_TURN = "Please ask_user which database to use.";

interface Frames {
  readonly lines: string[];
  readonly promptIds: string[];
}

interface BusyWire {
  readonly startTurn: (threadId: string) => Promise<void>;
  readonly revealTurnEvents: () => void;
}

/** Makes independent calls on the app's protocol to start and observe an ask_user turn while the page stays idle. */
async function installBusyWire(page: Page, frames: Frames): Promise<BusyWire> {
  const connected = Promise.withResolvers<void>();
  const pending = new Map<string, (frame: Record<string, unknown>) => void>();
  let sendToServer: ((message: string) => void) | undefined;
  let hideBusyEvents = false;

  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    sendToServer = (message) => server.send(message);
    connected.resolve();
    ws.onMessage((message) => {
      const text = String(message);
      const frame = JSON.parse(text) as Record<string, unknown>;
      frames.lines.push(`out ${text}`);
      if (frame.type === "call" && frame.method === "request") {
        const args = (frame.args ?? {}) as { method?: string };
        if (args.method === "prompt") frames.promptIds.push(String(frame.id));
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const text = String(message);
      const frame = JSON.parse(text) as Record<string, unknown>;
      const requestId = typeof frame.id === "string" ? frame.id : undefined;
      if (frame.type === "result" && requestId !== undefined) {
        const resolve = pending.get(requestId);
        if (resolve !== undefined) {
          pending.delete(requestId);
          frames.lines.push(`external in ${text}`);
          resolve(frame);
          return;
        }
      }
      const hidden =
        hideBusyEvents && (frame.type === "event" || frame.type === "extension_ui_request");
      frames.lines.push(`in${hidden ? " (hidden)" : ""} ${text}`);
      if (!hidden) ws.send(message);
    });
  });

  const call = async (method: string, args: Record<string, unknown>) => {
    await connected.promise;
    if (sendToServer === undefined) throw new Error("The app's socket is not connected.");
    const id = `external-${randomUUID()}`;
    const response = Promise.withResolvers<Record<string, unknown>>();
    pending.set(id, response.resolve);
    const request = JSON.stringify({ type: "call", id, port: "A0.chatSession", method, args });
    frames.lines.push(`external out ${request}`);
    sendToServer(request);
    return response.promise;
  };

  return {
    revealTurnEvents: () => {
      hideBusyEvents = false;
    },
    startTurn: async (threadId: string) => {
      hideBusyEvents = true;
      const accepted = await call("request", {
        threadId,
        method: "prompt",
        params: { text: QUESTION_TURN },
      });
      if (accepted.ok !== true) {
        throw new Error(
          `The test's call could not start its busy turn: ${JSON.stringify(accepted.error)}`,
        );
      }
      await expect
        .poll(
          async () => {
            const response = await call("openRequests", { threadId });
            const questions = response.value;
            return (
              response.ok === true &&
              Array.isArray(questions) &&
              questions.some((question) => JSON.stringify(question).includes("Which database?"))
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    },
  };
}
function sessionEventCount(frames: Frames, eventType: string): number {
  return frames.lines.filter((line) => {
    if (!line.startsWith("in {")) return false;
    const frame = JSON.parse(line.slice(3)) as {
      type?: unknown;
      payload?: { event?: { type?: unknown } };
    };
    return frame.type === "event" && frame.payload?.event?.type === eventType;
  }).length;
}
/** The call id of the first prompt sent with the given delivery, or undefined before it is sent. */
function callSentAs(frames: Frames, delivery: "followUp" | "steer"): string | undefined {
  const line = frames.lines.find(
    (entry) => entry.startsWith("out ") && entry.includes(`"streamingBehavior":"${delivery}"`),
  );
  return line === undefined ? undefined : /"id":"([^"]+)"/.exec(line)?.[1];
}
function promptTextSentAs(frames: Frames, delivery: "followUp" | "steer"): string | undefined {
  const line = frames.lines.find(
    (entry) => entry.startsWith("out ") && entry.includes(`"streamingBehavior":"${delivery}"`),
  );
  if (line === undefined) return undefined;
  const frame = JSON.parse(line.slice(4)) as { args?: { params?: { text?: unknown } } };
  const message = frame.args?.params?.text;
  return typeof message === "string" ? message : undefined;
}
function streamingBehaviorForText(frames: Frames, text: string): unknown {
  const line = frames.lines.find(
    (entry) => entry.startsWith("out ") && entry.includes(`"text":"${text}"`),
  );
  if (line === undefined) return undefined;
  const frame = JSON.parse(line.slice(4)) as {
    args?: { params?: { streamingBehavior?: unknown } };
  };
  return frame.args?.params?.streamingBehavior;
}
/** The status bar abbreviates ids; use the full thread id from the page's own send instead. */
function threadIdForPrompt(frames: Frames, text: string): string | undefined {
  for (const line of frames.lines) {
    if (!line.startsWith("out ")) continue;
    const frame = JSON.parse(line.slice(4)) as {
      type?: unknown;
      port?: unknown;
      method?: unknown;
      args?: { threadId?: unknown; method?: unknown; params?: { text?: unknown } };
    };
    const args = frame.args;
    if (
      frame.type === "call" &&
      frame.port === "A0.chatSession" &&
      frame.method === "request" &&
      args?.method === "prompt" &&
      args.params?.text === text &&
      typeof args?.threadId === "string"
    )
      return args.threadId;
  }
  return undefined;
}

/** Starts a fake-model turn through an independent call on the app's protocol, then checks the idle UI's real busy refusal. */
async function refusedSecondPrompt(
  page: Page,
  composer: Locator,
  frames: Frames,
  busyWire: BusyWire,
): Promise<void> {
  await sendPrompt(composer, "ready");
  await expect.poll(() => threadIdForPrompt(frames, "ready"), { timeout: 30_000 }).toBeDefined();
  const threadId = threadIdForPrompt(frames, "ready");
  if (threadId === undefined) {
    throw new Error("The full thread id was not captured from the sent prompt.");
  }
  // The bar draws the folder and the branch; the session id is in the folder's tooltip, in full.
  await expect(page.locator('[data-segment="N2.path"]')).toHaveAttribute(
    "title",
    new RegExp(`Session ID: ${threadId}`),
  );
  await expect(page.getByText("ready", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 60_000,
  });
  await busyWire.startTurn(threadId);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  await sendPrompt(composer, "hi");
  await expect(page.getByText("omp is still working on something.")).toBeVisible({
    timeout: 60_000,
  });
  // An idle composer sends a new prompt; a locally running composer would send a steer or follow-up instead.
  expect(streamingBehaviorForText(frames, "hi")).toBeUndefined();
  expect(frames.promptIds).toHaveLength(2);
  const refusedPromptId = frames.promptIds[1] ?? "";
  expect(refusedPromptId).not.toBe("");
  await expect
    .poll(() =>
      frames.lines.some(
        (line) =>
          line.startsWith("in ") &&
          line.includes(`"id":"${refusedPromptId}"`) &&
          line.includes('"ok":false'),
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("region", { name: "Conversation transcript" }).getByText("hi", { exact: true }),
  ).toHaveCount(0);
}

realTest.setTimeout(420_000);

realTest(
  "a prompt refused because omp is still busy reads as plain words, keeps the text, and sets no thread error",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const frames: Frames = { lines: [], promptIds: [] };
    let busyWire: BusyWire | undefined;
    const page = await realApp.open({
      beforeLoad: async (page) => {
        busyWire = await installBusyWire(page, frames);
      },
    });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    if (busyWire === undefined) throw new Error("The external busy wire was not installed.");
    await refusedSecondPrompt(page, composer, frames, busyWire);
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
  let busyWire: BusyWire | undefined;
  const page = await realApp.open({
    beforeLoad: async (page) => {
      busyWire = await installBusyWire(page, frames);
    },
  });
  const composer = await startChat(page);
  await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
  if (busyWire === undefined) throw new Error("The external busy wire was not installed.");
  await refusedSecondPrompt(page, composer, frames, busyWire);

  busyWire.revealTurnEvents();
  const queueUpdatesBeforeSteer = sessionEventCount(frames, "queue_update");
  await page.getByRole("button", { name: "Interrupt and send" }).click();
  await expect.poll(() => callSentAs(frames, "steer") !== undefined).toBe(true);
  await expect.poll(() => promptTextSentAs(frames, "steer")).toBe("hi");
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
  // The page must receive the server's queue update after the accepted steer before the busy actions disappear.
  await expect
    .poll(() => sessionEventCount(frames, "queue_update"))
    .toBeGreaterThan(queueUpdatesBeforeSteer);
  await expect(page.getByRole("button", { name: "Interrupt and send" })).toHaveCount(0);
});
