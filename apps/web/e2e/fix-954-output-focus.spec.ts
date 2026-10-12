import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect, openToolCard, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #954. "Load full output" keeps focus while the output loads: the button says it is busy with aria-disabled, not
 * disabled, so a keyboard user stays where they are. When the output is there, focus moves to the card's own "Show all"
 * control and a status line says "Full output loaded". The full output's read is held here, so the test can look at the
 * page while it loads. Real omp; the bash result is the one the history window holds in part (about 205 KB).
 */

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 5,000 rows of 41 characters and a newline each: about 205 KB, as the issue's result. */
const ROWS = Array.from(
  { length: 5000 },
  (_, index) => `row ${String(index + 1).padStart(4, "0")} ${"x".repeat(32)}`,
).join("\n");

realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        message: { role: "user", content: "print the rows", timestamp: 1 },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-rows",
              name: "bash",
              arguments: { command: "seq -f 'row %04g' 5000" },
            },
          ],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage: USAGE,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-rows",
          toolName: "bash",
          content: [{ type: "text", text: `${ROWS}\n\nWall time: 0.42 seconds` }],
          details: { wallTimeMs: 420 },
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "All 5000 rows are printed." }],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage: USAGE,
          stopReason: "stop",
          timestamp: 4,
        },
      },
    ],
  },
});

/** Whether a websocket message is the app's read of a tool output's full text (the SessionFileStore `readEntryOutput`). */
function isOutputRead(message: string | Buffer): boolean {
  try {
    const frame = JSON.parse(String(message)) as Record<string, unknown>;
    return (
      frame.type === "call" &&
      frame.port === "A1.sessionFileStore" &&
      frame.method === "readEntryOutput"
    );
  } catch {
    // Non-JSON frames are forwarded unchanged.
    return false;
  }
}

/**
 * Holds the app's reads of a tool output's full text while the test holds them. Other messages pass through unchanged;
 * `release` sends the held reads on, in the order they were made.
 */
function outputReadHold() {
  let holding = false;
  const held: { readonly server: WebSocketRoute; readonly message: string | Buffer }[] = [];
  return {
    async install(page: Page): Promise<void> {
      await page.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          webSocket.onMessage((message) => {
            if (holding && isOutputRead(message)) {
              held.push({ server, message });
              return;
            }
            server.send(message);
          });
        },
      );
    },
    hold(): void {
      holding = true;
    },
    release(): void {
      holding = false;
      for (const { server, message } of held.splice(0)) server.send(message);
    },
  };
}

/** Presses Tab until `target` has the keyboard focus, the way a keyboard user reaches the button. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let press = 0; press < 400; press += 1) {
    const focused = await target
      .evaluate((element) => element === document.activeElement)
      .catch(() => false);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("the keyboard never reached the button");
}

realTest(
  "Load full output keeps the keyboard focus while the output loads, then focus moves to Show all and the status says the output loaded",
  async ({ realApp }) => {
    const reads = outputReadHold();
    const page = await realApp.open({ beforeLoad: reads.install });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("All 5000 rows are printed.")).toBeVisible({ timeout: 60_000 });
    await mkdir(screenshots, { recursive: true });
    const card = page.getByTestId("u3-bash-card").first();
    await openToolCard(card);
    const load = card.getByRole("button", { name: "Load full output" });
    await expect(load).toBeVisible();

    // Before: the keyboard reaches the button.
    await tabTo(page, load);
    await expect(load).toBeFocused();

    // During: the read is held, and the button keeps the focus while it says the output is loading.
    reads.hold();
    await page.keyboard.press("Enter");
    const loading = card.getByRole("button", { name: "Loading full output…" });
    await expect(loading).toBeFocused();
    await expect(loading).toHaveAttribute("aria-disabled", "true");
    // The native disabled attribute is off: a disabled button would drop focus. (Playwright's toBeDisabled also reads aria-disabled.)
    await expect(loading).not.toHaveAttribute("disabled");

    // After: the note goes, focus is on the card's own Show all control, and a status line says the output is there.
    reads.release();
    const showAll = card.getByRole("button", { name: "Show all 5,000 lines" });
    await expect(showAll).toBeFocused({ timeout: 60_000 });
    await expect(card.getByText("Full output loaded")).toBeVisible();
    await expect(card.locator('[data-slot="u3-tool-card-cut"]')).toHaveCount(0);

    await waitForFiniteAnimations(page);
    await card.screenshot({ path: join(screenshots, "fix-954-loaded-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await card.screenshot({ path: join(screenshots, "fix-954-loaded-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await card.screenshot({ path: join(screenshots, "fix-954-loaded-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
