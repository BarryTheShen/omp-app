import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import { expect, realTest, screenshots, sendPrompt, waitForFiniteAnimations } from "./real-omp";

const MESSAGE_CHARACTERS = 1_500_000;

/**
 * Three long user messages in one session file. The newest window (4 MB) holds the last two, so the
 * chat opens with a "Show earlier messages" control, and the oldest message is paged in on request.
 */
function sessionLines(folder: string): string[] {
  const header = {
    type: "session",
    version: 3,
    id: "huge-history-paging-e2e",
    timestamp: "2026-10-05T00:00:00.000Z",
    cwd: folder,
  };
  const markers = ["OLDEST-MARK", "MIDDLE-MARK", "NEWEST-MARK"];
  const body = "lorem ipsum ".repeat(Math.ceil(MESSAGE_CHARACTERS / 12));
  const entries = markers.map((marker, index) => ({
    type: "message",
    id: `paging-${index + 1}`,
    parentId: index === 0 ? null : `paging-${index}`,
    timestamp: `2026-10-05T00:00:0${index + 1}.000Z`,
    message: { role: "user", content: `${marker} ${body}`, timestamp: index + 1 },
  }));
  return [header, ...entries].map((line) => JSON.stringify(line));
}

/** Light, dark and 390 px captures of the same view, with transitions finished before each one. */
async function captureLightDarkNarrow(page: Page, name: string): Promise<void> {
  const original = page.viewportSize();
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, `${name}-light.png`),
    animations: "disabled",
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, `${name}-dark.png`),
    animations: "disabled",
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, `${name}-narrow.png`),
    animations: "disabled",
    fullPage: true,
  });
  if (original !== null) await page.setViewportSize(original);
}

realTest(
  "a long chat opens on its newest messages and pages the earlier ones in on request",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const root = dirname(realApp.folder);
    const home = join(root, "home");
    const bucket = join(root, "agent", "sessions", sessionBucketName(realApp.folder, { home }));
    await mkdir(bucket, { recursive: true });
    await writeFile(
      join(bucket, "2026-10-05T00-00-00-000Z_huge-history-paging-e2e.jsonl"),
      `${sessionLines(realApp.folder).join("\n")}\n`,
    );

    const page = await realApp.open();
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });
    await list.getByRole("option").first().click();

    const earlier = page.getByRole("button", { name: "Show earlier messages" });
    await expect(earlier).toBeVisible({ timeout: 60_000 });
    const thread = page.locator('[data-slot="u1-thread-viewport"]');
    await expect(thread.getByText("NEWEST-MARK")).toBeVisible();
    await expect(thread.getByText("OLDEST-MARK")).toHaveCount(0);

    // Captures of the control where it sits, at the top of the transcript, before paging.
    await thread.evaluate((element) => {
      element.scrollTop = 0;
    });
    await captureLightDarkNarrow(page, "huge-history-paging-earlier");

    const newest = page.locator("[data-message-id]").last();
    // The reader is on the newest row: that row is the one the view must keep in place.
    await newest.evaluate((row) => row.scrollIntoView({ block: "start" }));
    const before = await newest.boundingBox();
    expect(before).not.toBeNull();

    // A script click: a Playwright click would scroll the control into view and move the reader.
    await earlier.evaluate((button) => {
      if (button instanceof HTMLElement) {
        button.focus({ preventScroll: true });
        button.click();
      }
    });
    await expect(thread.getByText("OLDEST-MARK")).toBeVisible({ timeout: 60_000 });
    await expect(earlier).toBeHidden();
    await expect(thread).toBeFocused();

    // The reader's place is kept: the newest row did not move by the height of the older rows.
    const after = await newest.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(5);
  },
);

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One bash call whose result is far over the reader's cut limit, with a marker at its very end. */
function shortenedOutputLines(folder: string): string[] {
  const output = `HEAD-${"output line ".repeat(Math.ceil(200_000 / 12))}-TAILMARK`;
  const entries = [
    {
      type: "message",
      id: "cut-1",
      parentId: null,
      timestamp: "2026-10-05T00:00:01.000Z",
      message: { role: "user", content: "print the log", timestamp: 1 },
    },
    {
      type: "message",
      id: "cut-2",
      parentId: "cut-1",
      timestamp: "2026-10-05T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-cut", name: "bash", arguments: { command: "cat big.log" } },
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
      id: "cut-3",
      parentId: "cut-2",
      timestamp: "2026-10-05T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-cut",
        toolName: "bash",
        content: [{ type: "text", text: output }],
        isError: false,
        timestamp: 3,
      },
    },
  ];
  const header = {
    type: "session",
    version: 3,
    id: "shortened-output-e2e",
    timestamp: "2026-10-05T00:00:00.000Z",
    cwd: folder,
  };
  return [header, ...entries].map((line) => JSON.stringify(line));
}

realTest(
  "a shortened tool output says how much it shows, and loads in full on request",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const root = dirname(realApp.folder);
    const bucket = join(
      root,
      "agent",
      "sessions",
      sessionBucketName(realApp.folder, { home: join(root, "home") }),
    );
    await mkdir(bucket, { recursive: true });
    await writeFile(
      join(bucket, "2026-10-05T00-00-00-000Z_shortened-output-e2e.jsonl"),
      `${shortenedOutputLines(realApp.folder).join("\n")}\n`,
    );

    const page = await realApp.open();
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });
    await list.getByRole("option").first().click();

    const thread = page.locator('[data-slot="u1-thread-viewport"]');
    const load = thread.getByRole("button", { name: "Load full output" });
    // The bash card the app holds in part says so once, and "Load full output" is the next step.
    const partialNote =
      /Showing the first [\d,]+ (?:lines|characters) of the [\d,]+ loaded; the app has loaded 64 KB of \d+ KB\./;
    await expect(thread.getByText(partialNote)).toBeVisible({ timeout: 60_000 });
    await captureLightDarkNarrow(page, "huge-history-paging-cut");
    await load.click();
    await expect(load).toBeHidden({ timeout: 60_000 });
    await expect(thread.getByText(partialNote)).toHaveCount(0);
  },
);

realTest(
  "a turn sent after a windowed open shows its answer once, in order, and paging keeps it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const root = dirname(realApp.folder);
    const bucket = join(
      root,
      "agent",
      "sessions",
      sessionBucketName(realApp.folder, { home: join(root, "home") }),
    );
    await mkdir(bucket, { recursive: true });
    await writeFile(
      join(bucket, "2026-10-05T00-00-00-000Z_huge-history-paging-e2e.jsonl"),
      `${sessionLines(realApp.folder).join("\n")}\n`,
    );

    const page = await realApp.open();
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });
    await list.getByRole("option").first().click();

    const thread = page.locator('[data-slot="u1-thread-viewport"]');
    const earlier = page.getByRole("button", { name: "Show earlier messages" });
    await expect(earlier).toBeVisible({ timeout: 60_000 });

    await sendPrompt(page.getByRole("textbox", { name: "Message input" }), "ping");
    await expect(thread.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    // The answer comes after the prompt, and appears in one row only.
    const rows = await thread.locator("[data-message-id]").allInnerTexts();
    const promptRow = rows.findIndex((text) => text.includes("ping"));
    const answerRow = rows.findIndex((text) => text.includes("pong"));
    expect(promptRow).toBeGreaterThanOrEqual(0);
    expect(answerRow).toBeGreaterThan(promptRow);
    expect(rows.filter((text) => text.includes("pong"))).toHaveLength(1);

    // A script click, as in the paging test: the reader keeps its place.
    await earlier.evaluate((button) => {
      if (button instanceof HTMLElement) button.click();
    });
    await expect(thread.getByText("OLDEST-MARK")).toBeVisible({ timeout: 60_000 });
    await expect(earlier).toBeHidden();
    await expect(thread.getByText("pong", { exact: true })).toHaveCount(1);
    const after = await thread.locator("[data-message-id]").allInnerTexts();
    expect(after.filter((text) => text.includes("pong"))).toHaveLength(1);
  },
);
