import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat } from "./real-omp";

/**
 * Sends events on a chat's event stream the way the server does. The page's socket is routed: the
 * stream comes from the page's `subscribe` frame, the highest sequence per stream from the events the
 * server sends, and every event sent here takes the next sequence. omp itself is not asked to send
 * anything.
 */
class ChatStream {
  private stream: string | undefined;
  private readonly sequences = new Map<string, number>();
  private toPage: { send(message: string): void } | undefined;
  private calls = 0;
  private lastCallAt = Date.now();

  public async route(target: Page): Promise<void> {
    await target.routeWebSocket(/.*/, (socket) => {
      this.toPage = socket;
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        if (typeof message === "string") {
          const subscribed = chatSubscription(message);
          if (subscribed !== undefined) {
            this.stream = subscribed;
            this.lastCallAt = Date.now();
            if (!this.sequences.has(subscribed)) this.sequences.set(subscribed, 0);
          }
          if (parseFrame(message)?.type === "call") {
            this.calls += 1;
            this.lastCallAt = Date.now();
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const event = typeof message === "string" ? chatEvent(message) : undefined;
        if (event !== undefined) {
          const seen = this.sequences.get(event.stream) ?? 0;
          this.sequences.set(event.stream, Math.max(seen, event.seq));
        }
        socket.send(message);
      });
    });
  }

  /** True once the page has subscribed to the chat's event stream. */
  public subscribed(): boolean {
    return this.stream !== undefined;
  }

  /** Requests the page has sent so far; a refetch shows up here. */
  public callCount(): number {
    return this.calls;
  }

  /** Milliseconds since the page last sent a request. */
  public quietForMs(): number {
    return Date.now() - this.lastCallAt;
  }

  public send(payload: unknown): void {
    const stream = this.stream;
    if (this.toPage === undefined || stream === undefined) {
      throw new Error("the chat's event stream has not been subscribed to yet");
    }
    const sequence = (this.sequences.get(stream) ?? 0) + 1;
    this.sequences.set(stream, sequence);
    this.toPage.send(JSON.stringify({ type: "event", stream, seq: sequence, payload }));
  }

  /** Sends one extension `notify` notice per message, as a notification event. */
  public notify(messages: readonly string[]): void {
    for (const message of messages) {
      this.send({
        kind: "notification",
        frame: {
          type: "extension_ui_request",
          id: `e2e-notice-${this.callCount()}-${message}`,
          method: "notify",
          message,
          notifyType: "info",
        },
      });
    }
  }
}

/**
 * Waits until the page has subscribed to the chat's event stream and has finished its opening
 * requests, so the notices sent next are not caught in the store's refetch.
 */
async function settleChat(chat: ChatStream): Promise<void> {
  await expect.poll(() => chat.subscribed(), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => chat.quietForMs(), { timeout: 60_000 }).toBeGreaterThan(2_000);
}

function parseFrame(message: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null ? { ...value } : undefined;
}

/** The stream of a chat's `subscribe` frame from the page, if this frame is one. */
function chatSubscription(message: string): string | undefined {
  const frame = parseFrame(message);
  if (frame?.type !== "subscribe" || typeof frame.stream !== "string") return undefined;
  return frame.stream.includes("rpcSession/event") ? frame.stream : undefined;
}

/** The stream and sequence of an event frame from the server, if this frame is one. */
function chatEvent(message: string): { stream: string; seq: number } | undefined {
  const frame = parseFrame(message);
  if (frame?.type !== "event" || typeof frame.stream !== "string") return undefined;
  if (typeof frame.seq !== "number") return undefined;
  return { stream: frame.stream, seq: frame.seq };
}

realTest(
  "a burst of notices shows three at a time, dismisses one, and lets the rest expire",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const chat = new ChatStream();
    const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
    await startChat(page);
    await settleChat(chat);

    chat.notify(Array.from({ length: 7 }, (_, index) => `Update ${index + 1}`));
    const feedback = page.getByTestId("n1-feedback");
    await expect(feedback.getByText("Update 7")).toBeVisible();
    await expect(feedback.getByText("Update 5")).toBeVisible();
    await expect(feedback.getByText("Update 4")).toHaveCount(0);
    await expect(page.getByTestId("n1-feedback-more")).toHaveText("+4 more");
    await page.screenshot({ path: join(screenshots, "n1-toasts-light.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(feedback.getByText("Update 7")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "n1-toasts-narrow.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    await feedback.getByRole("button", { name: "Dismiss notification" }).last().click();
    await expect(feedback.getByText("Update 7")).toHaveCount(0);
    await expect(page.getByTestId("n1-feedback-more")).toHaveText("+3 more");
    await expect(feedback.getByText("Update 4")).toBeVisible();

    // A toast under the pointer waits; moving the pointer away lets the six-second lifetime run out.
    await page.mouse.move(0, 0);
    await expect(feedback.getByText("Update 6")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("n1-feedback-more")).toHaveCount(0);
  },
);

realTest(
  "notices read in the dark theme keep their text and actions",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const chat = new ChatStream();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
        await chat.route(target);
      },
    });
    await startChat(page);
    await settleChat(chat);
    chat.notify(["Build finished", "Tests passed"]);
    const feedback = page.getByTestId("n1-feedback");
    await expect(feedback.getByText("Tests passed")).toBeVisible();
    await expect(feedback.getByRole("button", { name: "Dismiss notification" })).toHaveCount(2);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({ path: join(screenshots, "n1-toasts-dark.png"), fullPage: true });
  },
);
