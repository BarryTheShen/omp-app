import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

realTest.setTimeout(300_000);

const REQUEST_ID = "fix-1331-select";
const TITLE = "Choose an action";
/** Eight options, so the list shows its filter; "can" leaves only "Cancel" listed. */
const OPTIONS = ["Delete all", "Archive", "Rename", "Move", "Copy", "Export", "Share", "Cancel"];

/** The JSON object a socket message carries, or undefined for any other message. */
function parseFrame(message: string | Buffer): Record<string, unknown> | undefined {
  const text = typeof message === "string" ? message : message.toString("utf8");
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? { ...value } : undefined;
  } catch {
    return undefined;
  }
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/**
 * Puts a question on the chat's event stream, the way the server sends an extension UI request, and takes the page's
 * answer without forwarding it, so omp is not asked to know about the question. The routing is n1-toasts' ChatStream:
 * the stream comes from the page's subscribe frame, and each event sent here takes the next sequence.
 */
class SelectQuestion {
  /** The chat's event stream, once the page has subscribed to it. */
  public stream: string | undefined;
  /** When the page last sent a request. */
  public lastCallAt = Date.now();
  /** The `args` of each answer the page sent: `{ threadId, id, answer }`. */
  public readonly answers: unknown[] = [];
  private readonly sequences = new Map<string, number>();
  private page: { send(message: string): void } | undefined;

  public async route(target: Page): Promise<void> {
    await target.routeWebSocket(/\/ws\?/, (socket) => {
      this.page = socket;
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const frame = typeof message === "string" ? parseFrame(message) : undefined;
        if (
          frame?.type === "subscribe" &&
          typeof frame.stream === "string" &&
          frame.stream.includes("chatSession/event")
        ) {
          this.stream = frame.stream;
          if (!this.sequences.has(frame.stream)) this.sequences.set(frame.stream, 0);
        }
        if (frame?.type === "call") this.lastCallAt = Date.now();
        if (frame?.type === "call" && frame.method === "answer" && typeof frame.id === "string") {
          this.answers.push(frame.args);
          socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: null }));
          return;
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = typeof message === "string" ? parseFrame(message) : undefined;
        if (
          frame?.type === "event" &&
          typeof frame.stream === "string" &&
          typeof frame.seq === "number"
        ) {
          const seen = this.sequences.get(frame.stream) ?? 0;
          this.sequences.set(frame.stream, Math.max(seen, frame.seq));
        }
        socket.send(message);
      });
    });
  }

  public send(payload: unknown): void {
    const stream = this.stream;
    if (this.page === undefined || stream === undefined) {
      throw new Error("the chat's event stream has not been subscribed to yet");
    }
    const sequence = (this.sequences.get(stream) ?? 0) + 1;
    this.sequences.set(stream, sequence);
    this.page.send(JSON.stringify({ type: "event", stream, seq: sequence, payload }));
  }
}

/**
 * Issue #1331. A long select list: the person chooses an option, then types a filter that hides it. The choice the filter
 * hides is cleared, so Choose cannot send an option that is no longer listed. Enter on a listed option still chooses it.
 */
realTest(
  "a long select list clears a chosen option that its filter hides, so Choose sends only what is listed",
  async ({ realApp }) => {
    const question = new SelectQuestion();
    const page = await realApp.open({ beforeLoad: (target) => question.route(target) });
    await startChat(page);
    await expect.poll(() => question.stream !== undefined, { timeout: 60_000 }).toBe(true);
    // The page has finished its opening requests, so the question is not caught in a refetch.
    await expect
      .poll(() => Date.now() - question.lastCallAt, { timeout: 60_000 })
      .toBeGreaterThan(2_000);
    question.send({
      kind: "host_request",
      request: { id: REQUEST_ID, method: "ui.select", params: { title: TITLE, options: OPTIONS } },
    });

    const dialog = page.getByRole("dialog", { name: TITLE });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const filter = dialog.getByRole("textbox", { name: "Filter options" });
    const choose = dialog.getByRole("button", { name: "Choose", exact: true });
    await expect(choose).toBeDisabled();

    await dialog.getByRole("option", { name: "Delete all", exact: true }).click();
    await expect(choose).toBeEnabled();
    await filter.fill("can");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByRole("option", { name: "Cancel", exact: true })).toBeVisible();
    // The choice the filter hid is cleared, so Choose is off and nothing has been sent.
    await expect(choose).toBeDisabled();
    expect(question.answers).toEqual([]);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1331-select-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1331-select-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-1331-select-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Enter on the listed option chooses it at once: the answer goes out and the dialog closes, with no Choose.
    await filter.press("Enter");
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    expect(question.answers).toEqual([
      expect.objectContaining({ id: REQUEST_ID, answer: { value: "Cancel" } }),
    ]);
    expect(realApp.problems).toEqual([]);
  },
);
