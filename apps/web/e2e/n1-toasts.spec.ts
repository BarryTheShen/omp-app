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
  public notify(messages: readonly string[], notifyType: "info" | "error" = "info"): void {
    for (const message of messages) {
      this.send({
        kind: "notification",
        frame: {
          type: "extension_ui_request",
          id: `e2e-notice-${this.callCount()}-${message}`,
          method: "notify",
          message,
          notifyType,
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
    const feedback = page.getByTestId("n1-notices");
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
    const feedback = page.getByTestId("n1-notices");
    await expect(feedback.getByText("Tests passed")).toBeVisible();
    await expect(feedback.getByRole("button", { name: "Dismiss notification" })).toHaveCount(2);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({ path: join(screenshots, "n1-toasts-dark.png"), fullPage: true });
  },
);

/** The geometry notices must not change: the composer's top edge and height, the status bar's height and the context bar's width. */
async function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string): DOMRect => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`${selector} is not drawn`);
      return node.getBoundingClientRect();
    };
    return {
      composerTop: Math.round(box('[data-shell-region="composer"]').top),
      composerHeight: Math.round(box('[data-shell-region="composer"]').height),
      statusHeight: Math.round(box('[data-shell-region="status"]').height),
      contextWidth: Math.round(box('[data-surface="context"]').width),
    };
  });
}

/**
 * The geometry once the layout has settled. A load or a viewport change still moves the composer's toolbar and
 * the sidebars for a moment, so a baseline is taken only when two readings a frame apart agree.
 */
async function settledGeometry(page: Page) {
  await expect
    .poll(
      async () => {
        const first = await shellGeometry(page);
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        return JSON.stringify(first) === JSON.stringify(await shellGeometry(page));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return shellGeometry(page);
}

/** Opens the chat the seed makes: one turn of 60 steps, with its answer drawn. */
async function openLongChat(page: Page): Promise<void> {
  await page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: /Run the long job/ })
    .click();
  await expect(page.getByText("All 60 steps are done.")).toBeAttached({ timeout: 60_000 });
}

/** Scrolls the transcript up, away from its newest message, so "Jump to latest" is shown. */
async function scrollAway(page: Page): Promise<void> {
  await page.getByRole("region", { name: "Messages" }).hover();
  await page.mouse.wheel(0, -1_500);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
}

/**
 * The notices over a real transcript. The chat has messages under the notices and under the transcript's
 * footer, so a notice that covers the footer's controls, or a list the composer opens, shows up here. The
 * empty-transcript tests above do not show either.
 */
realTest.describe("notices over a real transcript", () => {
  realTest.use({ seedLongTurn: 60 });

  realTest(
    "notices float over the transcript: the composer and the context bar keep their place",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const chat = new ChatStream();
      const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
      await openLongChat(page);
      await settleChat(chat);
      const feedback = page.getByTestId("n1-notices");

      const desktop = await settledGeometry(page);
      chat.notify(Array.from({ length: 7 }, (_, index) => `Update ${index + 1}`));
      await expect(feedback.getByText("Update 7")).toBeVisible();
      await expect(page.getByTestId("n1-feedback-more")).toHaveText("+4 more");
      expect(await shellGeometry(page), "while three notices and +4 more show").toEqual(desktop);
      await page.screenshot({ path: join(screenshots, "fix-787-light.png") });

      // A toast under the pointer waits; moving the pointer away lets the six-second lifetime run out.
      await page.mouse.move(0, 0);
      await expect(feedback).toBeHidden({ timeout: 20_000 });
      expect(await shellGeometry(page), "after the notices expire").toEqual(desktop);

      await page.setViewportSize({ width: 390, height: 844 });
      const narrow = await settledGeometry(page);
      chat.notify(Array.from({ length: 4 }, (_, index) => `Narrow ${index + 1}`));
      await expect(feedback.getByText("Narrow 4")).toBeVisible();
      expect(await shellGeometry(page), "at 390 px while notices show").toEqual(narrow);
      await page.screenshot({ path: join(screenshots, "fix-787-narrow.png") });
      await page.mouse.move(0, 0);
      await expect(feedback).toBeHidden({ timeout: 20_000 });
      expect(await shellGeometry(page), "at 390 px after the notices expire").toEqual(narrow);
    },
  );

  realTest(
    "in the dark theme the notices float and the composer does not move",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const chat = new ChatStream();
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
          await chat.route(target);
        },
      });
      await openLongChat(page);
      await settleChat(chat);
      const before = await settledGeometry(page);
      chat.notify(["Build finished", "Tests passed"]);
      await expect(page.getByTestId("n1-notices").getByText("Tests passed")).toBeVisible();
      await expect(page.locator("html")).toHaveClass(/dark/);
      expect(await shellGeometry(page), "in the dark theme while notices show").toEqual(before);
      await page.screenshot({ path: join(screenshots, "fix-787-dark.png") });
    },
  );

  realTest(
    "Jump to latest is the hit target while three notices show, and the wheel over them scrolls the transcript",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const chat = new ChatStream();
      const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
      await openLongChat(page);
      await settleChat(chat);
      await scrollAway(page);

      // Errors stay until someone dismisses them, so the three are on screen for every check below.
      chat.notify(["Update 1", "Update 2", "Update 3"], "error");
      const feedback = page.getByTestId("n1-notices");
      await expect(feedback.getByText("Update 3")).toBeVisible();
      const jump = page.getByRole("button", { name: "Jump to latest message" });
      // A click lands on whatever is drawn at the button's centre; that has to be the button.
      const landsOnButton = await jump.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== null && button.contains(hit);
      });
      expect(landsOnButton, "the centre of Jump to latest is the button").toBe(true);
      await page.screenshot({ path: join(screenshots, "fix-787-jump-light.png") });

      const transcript = page.getByRole("region", { name: "Messages" });
      const scrollTop = () => transcript.evaluate((element) => element.scrollTop);
      const before = await scrollTop();
      await feedback.hover();
      await page.mouse.wheel(0, -300);
      await expect.poll(scrollTop).toBeLessThan(before);

      await jump.click();
      await expect
        .poll(() =>
          transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThan(80);
    },
  );

  realTest(
    "a command list drawn while notices show is the top element at its centre",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const chat = new ChatStream();
      const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
      await openLongChat(page);
      await settleChat(chat);

      chat.notify(["Update 1", "Update 2", "Update 3"], "error");
      await expect(page.getByTestId("n1-notices").getByText("Update 3")).toBeVisible();
      const composer = page.getByRole("textbox", { name: "Message input" });
      await composer.fill("/us");
      const list = page.getByRole("listbox", { name: "Slash commands" });
      // Wait for omp's commands, so the list is tall enough to reach the notices.
      await expect(list.getByRole("option", { name: /^\/usage/ })).toBeVisible({ timeout: 30_000 });
      const overlaps = await list.evaluate((root) => {
        const listBox = root.getBoundingClientRect();
        const noticeBox = document
          .querySelector('[data-testid="n1-notices"]')
          ?.getBoundingClientRect();
        return (
          noticeBox !== undefined &&
          listBox.left < noticeBox.right &&
          noticeBox.left < listBox.right &&
          listBox.top < noticeBox.bottom &&
          noticeBox.top < listBox.bottom
        );
      });
      expect(overlaps, "the open command list is drawn over the notices").toBe(true);
      const listOnTop = await list.evaluate((root) => {
        const box = root.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== null && root.contains(hit);
      });
      expect(listOnTop, "the centre of the open command list is the list").toBe(true);
      await page.screenshot({ path: join(screenshots, "fix-787-command-list-light.png") });
    },
  );
});
