import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { expect as realExpect, realTest, screenshots, startChat } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const PLAYGROUND = "/n1-3-feedback-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/N1/feedback/playground-entry.tsx",
      "--outfile",
      "dist/n1-3-feedback-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit an index stylesheet for N1.3.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "n1-3-feedback-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/assets/${css}" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <title>omp notices</title>
  </head>
  <body>
    <div id="n1-3-feedback-playground-root"></div>
    <script type="module" src="/n1-3-feedback-playground.js"></script>
  </body>
</html>
`,
  );
}

function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  return problems;
}

/** The top edge of a box on the page, or NaN when it is not drawn. */
async function topOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.y ?? Number.NaN;
}

test.beforeAll(buildPlaygroundPage);

test("a widget sits above or below the composer, and notices keep focus in the composer", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("n1-3-feedback-playground")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message input" });
  await composer.focus();

  await page.evaluate(() => {
    window.n1FeedbackPlayground?.setWidget("above", "aboveEditor", ["Shown above the composer"]);
    window.n1FeedbackPlayground?.setWidget("below", "belowEditor", ["Shown below the composer"]);
    window.n1FeedbackPlayground?.notify("Build finished", "info");
  });

  const feedback = page.getByTestId("n1-feedback");
  await expect(feedback.getByText("Build finished")).toBeVisible();
  await expect(composer).toBeFocused();
  const aboveTop = await topOf(page.getByText("Shown above the composer"));
  const composerTop = await topOf(composer);
  const belowTop = await topOf(page.getByText("Shown below the composer"));
  expect(aboveTop).toBeLessThan(composerTop);
  expect(belowTop).toBeGreaterThan(composerTop);

  await page.setViewportSize({ width: 640, height: 450 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "n1-3-feedback-playground-zoom.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect(problems).toEqual([]);
});

test("a dark playground keeps its notices' tone tokens", async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto(`${PLAYGROUND}?theme=dark`);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.evaluate(() => {
    window.n1FeedbackPlayground?.notify("Retry failed", "error");
  });
  const banner = page.getByTestId("n1-feedback").locator("article").first();
  await expect(banner).toBeVisible();
  const background = await banner.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "n1-3-feedback-playground-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  expect(problems).toEqual([]);
});

realTest(
  "a notice takes no focus, is read once, and the keyboard opens and dismisses the stack",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const chat = new ChatStream();
    const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
    await startChat(page);
    await settleChat(chat);

    const composer = page.getByRole("textbox", { name: "Message input" });
    await composer.click();
    chat.notify(["Update 1", "Update 2", "Update 3", "Update 4"]);
    const feedback = page.getByTestId("n1-feedback");
    await realExpect(feedback.getByText("Update 4")).toBeVisible();
    await realExpect(composer).toBeFocused();

    const polite = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-n1-live="polite"] p')).map(
        (item) => item.textContent,
      ),
    );
    expect(new Set(polite).size).toBe(polite.length);
    expect(polite).toContain("Update 4");
    await realExpect(page.locator('[data-n1-live="polite"]')).toHaveAttribute(
      "aria-atomic",
      "false",
    );
    await realExpect(page.locator('[data-n1-live="assertive"]')).toHaveAttribute(
      "aria-atomic",
      "false",
    );

    const more = page.getByTestId("n1-feedback-more");
    await realExpect(more).toHaveText("+1 more");
    await more.focus();
    await page.keyboard.press("Enter");
    await realExpect(more).toHaveAttribute("aria-expanded", "true");
    await realExpect(more).toBeFocused();

    const dismiss = feedback.getByRole("button", { name: "Dismiss notification" });
    await realExpect(dismiss).toHaveCount(4);
    await dismiss.nth(0).focus();
    await page.keyboard.press("Escape");
    await realExpect(feedback.getByText("Update 1", { exact: true })).toHaveCount(0);
    await realExpect(dismiss.nth(0)).toBeFocused();
  },
);

realTest(
  "notices read in light, dark and at 390 px with the design tokens loaded",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const chat = new ChatStream();
    const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
    await startChat(page);
    await settleChat(chat);
    chat.notify(["Build finished", "Tests passed"]);
    const feedback = page.getByTestId("n1-feedback");
    await realExpect(feedback.getByText("Tests passed")).toBeVisible();
    const toneOf = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(await toneOf(feedback.locator("article").first())).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: join(screenshots, "n1-3-feedback-light.png"),
      animations: "disabled",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await realExpect(feedback.getByText("Tests passed")).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "n1-3-feedback-narrow.png"),
      animations: "disabled",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 800 });

    const darkChat = new ChatStream();
    const dark = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
        await darkChat.route(target);
      },
    });
    await startChat(dark);
    await settleChat(darkChat);
    darkChat.notify(["Build finished", "Tests passed"]);
    await realExpect(dark.locator("html")).toHaveClass(/dark/);
    await realExpect(dark.getByTestId("n1-feedback").getByText("Tests passed")).toBeVisible();
    await dark.screenshot({
      path: join(screenshots, "n1-3-feedback-dark.png"),
      animations: "disabled",
      fullPage: true,
    });
  },
);

realTest(
  "the last notice dismissed from the keyboard returns focus to the composer, with the panels open",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const chat = new ChatStream();
    const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
    await startChat(page);
    await settleChat(chat);
    const composer = page.getByRole("textbox", { name: "Message input" });
    await composer.click();
    chat.notify(["Only one"]);
    const feedback = page.getByTestId("n1-feedback");
    await realExpect(feedback.getByText("Only one")).toBeVisible();

    await feedback.getByRole("button", { name: "Dismiss notification" }).focus();
    await page.keyboard.press("Escape");

    await realExpect(feedback.getByText("Only one")).toHaveCount(0);
    await realExpect(composer).toBeFocused();
  },
);

realTest(
  "the last notice dismissed from the keyboard returns focus to the composer, with the panels collapsed at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const chat = new ChatStream();
    const page = await realApp.open({ beforeLoad: (target) => chat.route(target) });
    await startChat(page);
    await settleChat(chat);
    await page.setViewportSize({ width: 390, height: 844 });
    const composer = page.getByRole("textbox", { name: "Message input" });
    await composer.click();
    chat.notify(["Only one"]);
    const feedback = page.getByTestId("n1-feedback");
    await realExpect(feedback.getByText("Only one")).toBeVisible();

    await feedback.getByRole("button", { name: "Dismiss notification" }).focus();
    await page.keyboard.press("Escape");

    await realExpect(feedback.getByText("Only one")).toHaveCount(0);
    await realExpect(composer).toBeFocused();
  },
);

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
          id: `n13-notice-${this.callCount()}-${message}`,
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
  await realExpect.poll(() => chat.subscribed(), { timeout: 60_000 }).toBe(true);
  await realExpect.poll(() => chat.quietForMs(), { timeout: 60_000 }).toBeGreaterThan(2_000);
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
