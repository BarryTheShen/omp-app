import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * omp writes a `compaction` entry when it compacts the conversation: the summary that replaced the older turns, with
 * the token counts and the method. A turn whose prompt cache went cold right after a warm one shows a cache row above
 * it. In the transcript the rows read in order: the warm answer, the compaction divider, the next user message, the
 * cache row, the cold answer. This opens a chat made of those entries and checks the rows come from history, also after
 * a reload, in light, dark and on a 390 px phone. A compaction made while the chat is open is not covered here.
 */

const at = Date.UTC(2026, 9, 10, 9, 0, 0);
const figures = (input: number, cacheRead: number, cacheWrite: number) => ({
  input,
  output: 5,
  cacheRead,
  cacheWrite,
  totalTokens: input + cacheRead + cacheWrite + 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const user = (text: string, timestamp: number) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp },
});
const assistant = (text: string, timestamp: number, usage: ReturnType<typeof figures>) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage,
    stopReason: "stop",
    timestamp,
  },
});

const entries = [
  user("Keep the parser stable.", at),
  assistant("Warm cache reply.", at + 1_000, figures(300, 4_000, 0)),
  {
    type: "compaction",
    summary: "## Goal\n\nKeep the parser stable across the refactor.",
    shortSummary: "The parser goal is kept.",
    firstKeptEntryId: "e000003",
    tokensBefore: 4_300,
    tokensAfter: 1_200,
    method: "remote",
    timestamp: new Date(at + 2_000).toISOString(),
  },
  user("Continue with the tests.", at + 3_000),
  assistant("Cold cache reply.", at + 4_000, figures(300, 0, 800)),
];

realTest.use({ seedEntries: { entries } });

const COMPACTION = '[data-slot="p7-compaction-summary-row"]';
const MISS = "[data-p7-cache-miss-divider]";
const MESSAGE = '[data-slot="u1-message-row"]';
const TRANSCRIPT = "Conversation transcript";
const SHOTS = join(screenshots, "fix-1277-compaction-divider");

/** Opens the seeded chat from the session list and waits for its last answer. */
async function openSeededChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 1500 });
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.locator(MESSAGE).filter({ hasText: "Cold cache reply." })).toBeVisible({
    timeout: 60_000,
  });
}

/** Opens the compaction divider the way a person does: its row first, then the "Read what was kept" summary. */
async function openDivider(page: Page): Promise<void> {
  const row = page.locator(COMPACTION);
  const button = row.getByRole("button", { name: "Conversation compacted remotely" });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(
    row.getByText("Before compaction: 4,300 tokens. After compaction: 1,200 tokens."),
  ).toBeVisible();
  await row.getByText("Read what was kept").click();
  await expect(row.getByText("Keep the parser stable across the refactor.")).toBeVisible();
}

/** The top edge of the first match, after it is visible: the rows are compared by where they sit on the page. */
async function topOf(locator: Locator): Promise<number> {
  await expect(locator.first()).toBeVisible();
  const box = await locator.first().boundingBox();
  if (box === null) throw new Error("A visible row has no box");
  return box.y;
}

/**
 * The page is painted with the design tokens: the body's background matches the `bg-background` token, and that token
 * is a colour (with no stylesheet, both are transparent).
 */
async function expectTokensLoaded(page: Page): Promise<void> {
  const style = await page.locator("body").evaluate((body) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.className = "bg-background";
    document.body.append(tokenProbe);
    const result = {
      background: getComputedStyle(body).backgroundColor,
      backgroundToken: getComputedStyle(tokenProbe).backgroundColor,
    };
    tokenProbe.remove();
    return result;
  });
  expect(style.backgroundToken).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.background).toBe(style.backgroundToken);
}

/**
 * The compaction divider, the cache row and the two answers, in the order they read down the transcript. The cache row
 * reads the reprocessed count (300 new tokens and 800 written into the cache: 1,100).
 */
async function checkRows(page: Page, label: string): Promise<void> {
  const row = page.locator(COMPACTION);
  const miss = page.locator(MISS);
  await expect(row, `${label}: one compaction divider`).toHaveCount(1);
  await expect(miss, `${label}: one cache row`).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Conversation compacted remotely" })).toBeVisible();
  await expect(
    miss.getByText("The prompt cache went cold, so omp processed 1,100 tokens again."),
  ).toBeVisible();
  const warm = await topOf(page.locator(MESSAGE).filter({ hasText: "Warm cache reply." }));
  const divider = await topOf(row);
  const cacheRow = await topOf(miss);
  const cold = await topOf(page.locator(MESSAGE).filter({ hasText: "Cold cache reply." }));
  expect(divider, `${label}: the divider comes after the warm answer`).toBeGreaterThan(warm);
  expect(cacheRow, `${label}: the cache row comes after the divider`).toBeGreaterThan(divider);
  expect(cold, `${label}: the cold answer comes after its cache row`).toBeGreaterThan(cacheRow);
  await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);
}

realTest(
  "a compaction shows its divider, and the cold turn after it shows the cache row above it, in order, from history and after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await mkdir(SHOTS, { recursive: true });
    const page = await realApp.open();
    await openSeededChat(page);
    await checkRows(page, "first open");
    await openDivider(page);
    await waitForFiniteAnimations(page);
    await expectTokensLoaded(page);
    await page.getByRole("region", { name: TRANSCRIPT }).screenshot({
      animations: "disabled",
      path: join(SHOTS, "light.png"),
    });

    await page.reload();
    await openSeededChat(page);
    await checkRows(page, "after a reload");
  },
);

realTest(
  "the divider and the cache row read in dark, and fit a 390 px phone",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await mkdir(SHOTS, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await openSeededChat(page);
    await checkRows(page, "dark");
    await openDivider(page);
    await waitForFiniteAnimations(page);
    await expectTokensLoaded(page);
    await page.getByRole("region", { name: TRANSCRIPT }).screenshot({
      animations: "disabled",
      path: join(SHOTS, "dark.png"),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(MISS)).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(fits).toBe(true);
    await waitForFiniteAnimations(page);
    await expectTokensLoaded(page);
    await page.getByRole("region", { name: TRANSCRIPT }).screenshot({
      animations: "disabled",
      path: join(SHOTS, "narrow-390.png"),
    });
  },
);
