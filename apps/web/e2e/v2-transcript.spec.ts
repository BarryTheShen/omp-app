import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect, type RealApp, realTest, startNewChat } from "./real-omp";

/** The new UI's transcript (`apps/ui`, under `/v2/`) on real omp: a failed request and what it offers. */
realTest.describe("new UI transcript", () => {
  realTest.setTimeout(240_000);

  async function newChat(realApp: RealApp): Promise<Page> {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Message omp",
      { timeout: 120_000 },
    );
    return page;
  }

  /** The failed replies omp saved in its session files. */
  async function failedReplies(agentDir: string): Promise<number> {
    const root = join(agentDir, "sessions");
    const files = (await readdir(root, { recursive: true })).filter((name) =>
      name.endsWith(".jsonl"),
    );
    let count = 0;
    for (const name of files) {
      const lines = (await readFile(join(root, name), "utf8")).split("\n");
      count += lines.filter((line) => line.includes('"stopReason":"error"')).length;
    }
    return count;
  }

  realTest(
    "a failed request shows once, with Copy error, Switch model and Retry",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("provider_failure_long");
      await box.press("Enter");

      const failure = page.getByRole("alert").filter({ hasText: "The request failed" });
      await expect(failure).toHaveCount(1, { timeout: 60_000 });
      await expect(failure).toContainText("The fake provider rejected this request.");

      await failure.getByRole("button", { name: "Copy error" }).click();
      await expect(failure.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
        "The fake provider rejected this request.",
      );

      await failure.getByRole("button", { name: "Switch model" }).click();
      const findModel = page.getByPlaceholder("Find a model");
      await expect(findModel).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(findModel).toBeHidden();

      // omp's own `/retry` runs the failed turn again; the fake provider fails it again.
      await failure.getByRole("button", { name: "Retry" }).click();
      await expect.poll(() => failedReplies(realApp.agentDir), { timeout: 60_000 }).toBe(2);
      await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1, { timeout: 60_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a tool call stopped and retried shows as running again, not as aborted, then its new result",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const box = page.getByRole("textbox", { name: "Message" });
      const transcript = page.getByRole("region", { name: "Transcript" });
      const stopped = transcript.getByText("Interrupted by user");
      await box.fill("slow_tool 8");
      await box.press("Enter");
      const call = transcript.getByText("sleep 8; echo slow-tool-done").first();
      await expect(call).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "Stop" }).first().click();
      await expect(stopped).toBeVisible({ timeout: 30_000 });

      // omp's retry runs the stopped call again (its tool replay): meanwhile the stop and its result are gone.
      await box.click();
      await page.keyboard.press("Alt+R");
      await expect(page.getByText("Running bash")).toBeVisible({ timeout: 30_000 });
      await expect(stopped).toHaveCount(0);

      // The rerun's result came back: the model's reply quotes it, and the stop stays gone.
      await expect(transcript.getByText("tool said: slow-tool-done")).toBeVisible({
        timeout: 60_000,
      });
      await expect(stopped).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a code block in a reply shows Copy under the pointer, and it copies the code alone",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("stream_code");
      await box.press("Enter");

      const block = page.locator("pre").filter({ hasText: "export const answer" });
      await expect(block).toBeVisible({ timeout: 60_000 });
      // The block is drawn again, as a settled reply, when the turn ends; the Copy button to press is that one.
      await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 60_000 });
      const copy = page.getByRole("button", { name: "Copy code" });
      // The pointer rests on the message box, away from the block (the click that opened the chat left it mid-window).
      await box.hover();
      await expect(copy).toHaveCSS("opacity", "0");
      await block.hover();
      await expect(copy).toHaveCSS("opacity", "1");
      await copy.click();
      await expect(copy).toHaveText("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        [
          "export function sum(values: number[]): number {",
          "  let total = 0;",
          "  for (const value of values) {",
          "    total += value;",
          "  }",
          "  return total;",
          "}",
          "",
          "export const answer = sum([1, 2, 3]);",
        ].join("\n"),
      );
      await expect(copy).toHaveText("Copy", { timeout: 5_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a table keeps its words whole in a narrow column, and a table wider than the chat scrolls inside itself",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await page.setViewportSize({ width: 1000, height: 800 });
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("table_probe");
      await box.press("Enter");
      const tables = page.locator(".tr-md table");
      await expect(tables).toHaveCount(2, { timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 60_000 });

      // Each one-word cell of the short column is drawn on one line, not broken letter by letter (#2777).
      const lines = await tables
        .first()
        .locator("tbody td:first-child")
        .evaluateAll((cells) =>
          cells.map((cell) => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
          }),
        );
      expect(lines).toEqual([1, 1, 1]);

      // The table with a long address is wider than the chat: it scrolls inside itself and stays within its column.
      const wide = await tables.nth(1).evaluate((table) => ({
        scrolls: table.scrollWidth > table.clientWidth,
        overflowX: getComputedStyle(table).overflowX,
        within:
          table.getBoundingClientRect().width <=
          (table.parentElement?.getBoundingClientRect().width ?? 0) + 1,
      }));
      expect(wide).toEqual({ scrolls: true, overflowX: "auto", within: true });
      expect(realApp.problems).toEqual([]);
    },
  );
});

/** omp's IRC message and a launch's ended processes, as a chat's file holds them (#2827). */
const NOTICES_AT = Date.UTC(2026, 10, 4, 15, 0, 0);
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NOTICE_ENTRIES = [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "notices question" }],
      timestamp: NOTICES_AT,
    },
  },
  {
    type: "custom_message",
    customType: "irc:incoming",
    content:
      '<irc>\nIncoming IRC message from agent `StressA`:\n\nBB probe passed with no findings.\n\nIf response expected, reply via `write` (`path: "agent://StressA"`); may finish current step first.\n</irc>',
    display: true,
    details: { id: "irc-1", from: "StressA", message: "BB probe passed with no findings." },
    timestamp: "2026-11-04T15:00:05.000Z",
  },
  {
    type: "custom_message",
    customType: "launch-completion",
    content: "Launch finished.",
    display: true,
    details: {
      daemons: [
        {
          name: "dev-server",
          state: "exited",
          exitCode: 0,
          startedAt: NOTICES_AT,
          exitedAt: NOTICES_AT + 2_500,
        },
      ],
    },
    timestamp: "2026-11-04T15:00:08.000Z",
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "All done here." }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: NOTICES_AT + 10_000,
    },
  },
];

realTest.describe("new UI transcript: omp's own messages", () => {
  realTest.use({ seedEntries: { entries: NOTICE_ENTRIES } });

  realTest(
    "an IRC message shows who wrote it and what it says, and a launch's process its row, not the text for the model (#2827)",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: /^notices question/ })
        .click({ timeout: 120_000 });
      const transcript = page.getByRole("region", { name: "Transcript" });
      await expect(transcript.getByText("All done here.")).toBeVisible({ timeout: 60_000 });
      await expect(transcript.getByText("Message from StressA")).toBeVisible();
      await expect(transcript.getByText("BB probe passed with no findings.")).toBeVisible();
      await expect(transcript.getByText("Supervised process completed")).toBeVisible();
      await expect(transcript.getByText("dev-server")).toBeVisible();
      // None of what omp tells the model.
      await expect(transcript).not.toContainText("<irc>");
      await expect(transcript).not.toContainText("If response expected");
      await expect(transcript).not.toContainText("irc:incoming");
      expect(realApp.problems).toEqual([]);
    },
  );
});

/** A chat several of a phone's older windows long (128 KB each): 120 questions and answers of about 1 KB each. */
const LONG_AT = Date.UTC(2026, 10, 1, 12);
const LONG_TEXT =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(10);
const LONG_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const LONG_CHAT = Array.from({ length: 120 }, (_, index) => {
  const asked = LONG_AT + index * 120_000;
  return [
    {
      type: "message",
      timestamp: new Date(asked).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: `Question ${index + 1}: ${LONG_TEXT}` }],
        timestamp: asked,
      },
    },
    {
      type: "message",
      timestamp: new Date(asked + 5_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Answer ${index + 1}. ${LONG_TEXT}` }],
        api: "openai-completions",
        provider: "fake",
        model: "fake-model",
        usage: LONG_USAGE,
        stopReason: "stop",
        timestamp: asked + 5_000,
      },
    },
  ];
}).flat();

/** What the test does with one of the page's reads of an older window: pass it on, or answer it with a failure. */
type OlderRead = (pass: () => void, fail: () => void) => void;

/** Safari on an iPhone: TanStack Virtual handles touches as iOS's from its user agent. */
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1";

realTest.describe("new UI transcript: a long chat's earlier messages on a phone", () => {
  realTest.use({ seedEntries: { entries: LONG_CHAT } });
  realTest.setTimeout(240_000);

  /**
   * The app on a phone's screen with the long chat open at its end; `olderRead` sees each read of an older window. A
   * `userAgent` makes the page another browser's.
   */
  async function openLongChat(
    realApp: RealApp,
    browser: Browser,
    olderRead: OlderRead,
    userAgent?: string,
  ): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      ...(userAgent === undefined ? {} : { userAgent }),
    });
    const page = await realApp.open({
      path: "/",
      context,
      beforeLoad: (opened) =>
        opened.routeWebSocket(
          () => true,
          (webSocket) => {
            const server = webSocket.connectToServer();
            webSocket.onMessage((message) => {
              const older =
                typeof message === "string" &&
                message.includes('"method":"readEntryWindow"') &&
                message.includes('"before"');
              if (!older) {
                server.send(message);
                return;
              }
              const { id } = JSON.parse(message) as { id: string };
              olderRead(
                () => server.send(message),
                () =>
                  webSocket.send(
                    JSON.stringify({
                      type: "result",
                      id,
                      ok: false,
                      error: { code: "internal", message: "The read failed.", retryable: false },
                    }),
                  ),
              );
            });
            server.onMessage((message) => webSocket.send(message));
          },
        ),
    });
    await page.getByRole("button", { name: "Chats", exact: true }).tap();
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: /^Question 1:/ })
      .tap({ timeout: 120_000 });
    await expect(
      page.getByRole("region", { name: "Transcript" }).getByText("Answer 120.", { exact: false }),
    ).toBeVisible({ timeout: 60_000 });
    return { page, context };
  }

  /**
   * Scrolls the transcript up with the wheel, as a reader does, until its top band reads `band` on screen. Each window
   * read keeps the reader's place, so the band it changed is above the view until the reader scrolls up to it.
   */
  async function upTo(page: Page, band: RegExp): Promise<void> {
    const transcript = page.getByRole("region", { name: "Transcript" });
    const edge = transcript.locator("[data-transcript-edge]");
    await transcript.hover();
    await expect(async () => {
      await page.mouse.wheel(0, -100_000);
      await expect(edge).toHaveText(band, { timeout: 2_000 });
      await expect(edge).toBeInViewport({ timeout: 2_000 });
    }).toPass({ timeout: 90_000 });
  }

  realTest(
    "at the top it says Loading earlier messages while it reads them, and shows the day the chat began above its first message",
    async ({ realApp, browser }) => {
      // Each older window answers 1.5 s late, so the top shows its read under way.
      const { page, context } = await openLongChat(realApp, browser, (pass) => {
        setTimeout(pass, 1_500);
      });
      const transcript = page.getByRole("region", { name: "Transcript" });
      const edge = transcript.locator("[data-transcript-edge]");
      await transcript.hover();
      await page.mouse.wheel(0, -100_000);
      await expect(edge).toHaveText("Loading earlier messages…");
      await expect(edge).toBeInViewport();
      await upTo(page, /^Beginning of the chat · Nov 1, 2026$/);
      await expect(edge).toBeInViewport();
      await expect(transcript.getByText("Question 1:", { exact: false })).toBeVisible();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "an older window that could not be read says so, and Try again reads it",
    async ({ realApp, browser }) => {
      let failures = 1;
      const { page, context } = await openLongChat(realApp, browser, (pass, fail) => {
        if (failures > 0) {
          failures -= 1;
          fail();
        } else pass();
      });
      const transcript = page.getByRole("region", { name: "Transcript" });
      const edge = transcript.locator("[data-transcript-edge]");
      await transcript.hover();
      await page.mouse.wheel(0, -100_000);
      await expect(edge).toContainText("Couldn't load earlier messages.");
      // A read that failed while the link stayed up is not repeated by itself.
      await page.waitForTimeout(1_500);
      await expect(edge).toContainText("Couldn't load earlier messages.");
      await edge.getByRole("button", { name: "Try again" }).tap();
      await upTo(page, /^Beginning of the chat · Nov 1, 2026$/);
      await expect(transcript.getByText("Question 1:", { exact: false })).toBeVisible();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "on an iPhone, a swipe up that ends in a bounce at the top leaves every row above within reach once the scroll rests",
    async ({ realApp, browser }) => {
      const { page, context } = await openLongChat(
        realApp,
        browser,
        (pass) => pass(),
        IPHONE_SAFARI,
      );
      const transcript = page.getByRole("region", { name: "Transcript" });
      /** Rows drawn above the transcript's top: a bounce shows them, no scroll reaches them. */
      const drawnAbove = (): Promise<number> =>
        transcript.evaluate((element) => {
          const top = (element.firstElementChild as HTMLElement).getBoundingClientRect().top;
          return [...element.querySelectorAll("[data-index]")].filter(
            (row) => row.getBoundingClientRect().top < top - 1,
          ).length;
        });
      const finger = (down: boolean): Promise<void> =>
        transcript.evaluate((element, isDown) => {
          const touch = new Touch({ identifier: 1, target: element, clientX: 195, clientY: 400 });
          const touches = isDown ? [touch] : [];
          element.dispatchEvent(
            new TouchEvent(isDown ? "touchstart" : "touchend", {
              touches,
              targetTouches: touches,
              changedTouches: [touch],
              bubbles: true,
            }),
          );
        }, down);
      await page.waitForTimeout(1_000);

      // A finger drags the transcript up to the top of what is drawn. The rows above are measured on the way and the
      // next older window is read; TanStack holds the corrections while the finger is down.
      await finger(true);
      for (let step = 0; step < 100; step += 1) {
        const top = await transcript.evaluate((element) => {
          element.scrollTop = Math.max(0, element.scrollTop - 800);
          return element.scrollTop;
        });
        await page.waitForTimeout(30);
        if (top === 0) break;
      }

      // The bounce at the top as an iPhone reports it: a position past the top as the finger lifts, read so again
      // 150 ms after the last event, and the bounce settling at the top with no event after it.
      await transcript.evaluate((element) => {
        Object.defineProperty(element, "scrollTop", { configurable: true, get: () => -40 });
        element.dispatchEvent(new Event("scroll"));
      });
      await finger(false);
      await page.waitForTimeout(400);
      await transcript.evaluate((element) => Reflect.deleteProperty(element, "scrollTop"));

      // Once the scroll rests, nothing is drawn above the top and the transcript has room to scroll up.
      await expect.poll(drawnAbove).toBe(0);
      await expect
        .poll(() => transcript.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "on an iPhone, earlier messages read during one long swipe up can be scrolled to in that same swipe",
    async ({ realApp, browser }) => {
      let reads = 0;
      const { page, context } = await openLongChat(
        realApp,
        browser,
        (pass) => {
          reads += 1;
          pass();
        },
        IPHONE_SAFARI,
      );
      const transcript = page.getByRole("region", { name: "Transcript" });
      /** Rows drawn above the transcript's top: a bounce shows them, no scroll reaches them. */
      const drawnAbove = (): Promise<number> =>
        transcript.evaluate((element) => {
          const top = (element.firstElementChild as HTMLElement).getBoundingClientRect().top;
          return [...element.querySelectorAll("[data-index]")].filter(
            (row) => row.getBoundingClientRect().top < top - 1,
          ).length;
        });
      /** Whether the chat's first question is on screen in the transcript. */
      const firstInView = (): Promise<boolean> =>
        transcript.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [...element.querySelectorAll<HTMLElement>("[data-index]")].some((row) => {
            const rect = row.getBoundingClientRect();
            return (
              rect.bottom > box.top &&
              rect.top < box.bottom &&
              (row.textContent ?? "").includes("Question 1:")
            );
          });
        });
      const finger = (down: boolean): Promise<void> =>
        transcript.evaluate((element, isDown) => {
          const touch = new Touch({ identifier: 1, target: element, clientX: 195, clientY: 400 });
          const touches = isDown ? [touch] : [];
          element.dispatchEvent(
            new TouchEvent(isDown ? "touchstart" : "touchend", {
              touches,
              targetTouches: touches,
              changedTouches: [touch],
              bubbles: true,
            }),
          );
        }, down);
      await page.waitForTimeout(1_000);

      // One finger stays down from the chat's end to its first question. The older window is read on the way, and
      // comes while the finger is down.
      await finger(true);
      let reached = false;
      for (let step = 0; step < 400 && !reached; step += 1) {
        await transcript.evaluate((element) => {
          element.scrollTop = Math.max(0, element.scrollTop - 600);
        });
        await page.waitForTimeout(40);
        reached = await firstInView();
      }
      expect(reads).toBeGreaterThanOrEqual(1);
      expect(reached).toBe(true);
      expect(await drawnAbove()).toBe(0);

      // Once the finger lifts and the scroll rests, the spare room above the chat's beginning goes: the first question
      // is still on screen, and nothing is drawn above the top.
      await finger(false);
      await page.waitForTimeout(1_000);
      expect(await firstInView()).toBe(true);
      expect(await drawnAbove()).toBe(0);
      await expect(transcript.getByText(/^Beginning of the chat/)).toBeVisible();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
