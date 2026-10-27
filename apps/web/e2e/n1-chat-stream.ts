import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Sends events on a chat's event stream the way the server does. The page's socket is routed: the
 * stream comes from the page's `subscribe` frame, the highest sequence per stream from the events
 * the server sends, and every event sent here takes the next sequence. omp itself is not asked to
 * send anything.
 */
export class ChatStream {
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

  /** Sends one extension `notify` notice per message, as the chat host's `ui_notify` event. */
  public notify(
    messages: readonly string[],
    notifyType: "info" | "warning" | "error" = "warning",
  ): void {
    for (const message of messages) {
      this.send({ kind: "event", event: { type: "ui_notify", message, notifyType } });
    }
  }
}

/**
 * Waits until the page has subscribed to the chat's event stream and has finished its opening
 * requests, so the notices sent next are not caught in the store's refetch.
 */
export async function settleChat(chat: ChatStream): Promise<void> {
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
  return frame.stream.includes("chatSession/event") ? frame.stream : undefined;
}

/** The stream and sequence of an event frame from the server, if this frame is one. */
function chatEvent(message: string): { stream: string; seq: number } | undefined {
  const frame = parseFrame(message);
  if (frame?.type !== "event" || typeof frame.stream !== "string") return undefined;
  if (typeof frame.seq !== "number") return undefined;
  return { stream: frame.stream, seq: frame.seq };
}
