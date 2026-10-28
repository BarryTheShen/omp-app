import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const HISTORY_CHORD = "Control+Shift+H";
const at = Date.UTC(2026, 9, 15, 10, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const entries = [
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "first W6 message" }], timestamp: at },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "first W6 reply" }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: at + 1_000,
    },
  },
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "second W6 message" }],
      timestamp: at + 2_000,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "second W6 reply" }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: at + 3_000,
    },
  },
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "third W6 message" }],
      timestamp: at + 4_000,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "third W6 reply" }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: at + 5_000,
    },
  },
  { type: "label", targetId: "e000000", label: "W6 checkpoint", timestamp: iso(at + 6_000) },
];

realTest.use({ seedEntries: { entries } });
realTest.setTimeout(300_000);

async function openSeededSession(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 900 });
  const source = page.getByRole("listbox", { name: "Session list" }).getByRole("option").first();
  await source.click();
  await expect(page.getByText("third W6 message", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const sourceUpdatedAt = await source.locator("time").getAttribute("datetime");
  if (sourceUpdatedAt === null) throw new Error("The source session has no update time.");
  return sourceUpdatedAt;
}

async function openHistoryPanel(page: Page): Promise<void> {
  await page.keyboard.press(HISTORY_CHORD);
  await expect(page.getByRole("tab", { name: "Conversation history" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}
async function sessionFiles(agentDir: string): Promise<string[]> {
  try {
    const files = await readdir(join(agentDir, "sessions"), { recursive: true });
    return files.filter((file) => file.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

async function capturePicker(page: Page, name: string): Promise<void> {
  const picker = page.getByTestId("tree-picker-dialog");
  const font = await picker.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(font).not.toMatch(/Times/);
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

realTest(
  "the real W6 session lists entries, rewinds from an earlier message, keeps its label, and leaves the source intact",
  async ({ realApp }) => {
    const page = await realApp.open();
    const sourceUpdatedAt = await openSeededSession(page);
    await openHistoryPanel(page);

    const tree = page.getByRole("tree", { name: "Conversation messages" });
    await expect(tree.getByRole("treeitem", { name: /second W6 message/ })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: /third W6 message/ })).toBeVisible();

    const second = tree.getByRole("treeitem", { name: /second W6 message/ });
    await second.click();
    await page.getByRole("button", { name: "Choose a message" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a message" });
    const selected = picker.getByRole("treeitem", { name: /second W6 message/ });
    await selected.click();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await picker.getByRole("button", { name: "Rewind here", exact: true }).click();

    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("first W6 message", { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect(transcript.getByText("second W6 message", { exact: true })).toHaveCount(0);
    await expect(transcript.getByText("third W6 message", { exact: true })).toHaveCount(0);

    const optionsBeforeReload = page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option");
    const beforeReloadOptions = await optionsBeforeReload.allTextContents();
    const beforeReloadFiles = await sessionFiles(realApp.agentDir);
    await page.reload();
    const sessions = page.getByRole("listbox", { name: "Session list" });
    const options = sessions.getByRole("option");
    const afterReloadFiles = await sessionFiles(realApp.agentDir);
    await expect(
      options,
      `Before reload: options=${JSON.stringify(beforeReloadOptions)}, files=${JSON.stringify(beforeReloadFiles)}; after reload files=${JSON.stringify(afterReloadFiles)}`,
    ).toHaveCount(2, { timeout: 60_000 });
    const original = options.filter({
      has: page.locator(`time[datetime="${sourceUpdatedAt}"]`),
    });
    await expect(original).toHaveCount(1);
    await original.click();
    // Opening the chat starts its omp, as at the other opens in this case.
    await expect(transcript.getByText("first W6 message", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(transcript.getByText("second W6 message", { exact: true })).toBeVisible();
    await expect(transcript.getByText("third W6 message", { exact: true })).toBeVisible();
    await openHistoryPanel(page);
    let labels = page.getByRole("region", { name: "Labels" });
    await expect(labels.getByText("W6 checkpoint", { exact: true })).toBeVisible();
    await expect(labels.getByText("1 label", { exact: true })).toBeVisible();

    await page.reload();
    await expect(options).toHaveCount(2, { timeout: 60_000 });
    const branched = options.filter({
      hasNot: page.locator(`time[datetime="${sourceUpdatedAt}"]`),
    });
    await expect(branched).toHaveCount(1);
    await branched.click();
    await expect(transcript.getByText("first W6 message", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(transcript.getByText("second W6 message", { exact: true })).toHaveCount(0);
    await expect(transcript.getByText("third W6 message", { exact: true })).toHaveCount(0);
    await openHistoryPanel(page);
    labels = page.getByRole("region", { name: "Labels" });
    await expect(labels.getByText("W6 checkpoint", { exact: true })).toBeVisible();
    await expect(labels.getByText("1 label", { exact: true })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the real W6 session forks from an earlier message, keeps the source and label, and reloads the forked head",
  async ({ realApp }) => {
    const page = await realApp.open();
    const sourceUpdatedAt = await openSeededSession(page);
    await openHistoryPanel(page);

    const tree = page.getByRole("tree", { name: "Conversation messages" });
    const second = tree.getByRole("treeitem", { name: /second W6 message/ });
    await second.click();
    await page.getByRole("button", { name: "Choose a message" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a message" });
    await picker.getByRole("treeitem", { name: /second W6 message/ }).click();
    const third = picker.getByRole("treeitem", { name: /third W6 message/ });
    await third.focus();
    await expect(picker.getByRole("treeitem", { name: /second W6 message/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await capturePicker(page, "p4-6-fork-picker-light.png");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await capturePicker(page, "p4-6-fork-picker-dark.png");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await capturePicker(page, "p4-6-fork-picker-narrow.png");
    await page.setViewportSize({ width: 1280, height: 900 });
    await picker.getByRole("button", { name: "Fork here", exact: true }).click();

    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("first W6 message", { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect(transcript.getByText("second W6 message", { exact: true })).toBeVisible();
    await expect(transcript.getByText("third W6 message", { exact: true })).toHaveCount(0);
    await page.reload();

    const sessions = page.getByRole("listbox", { name: "Session list" });
    const options = sessions.getByRole("option");
    await expect(options).toHaveCount(2, { timeout: 60_000 });
    const source = options.filter({ has: page.locator(`time[datetime="${sourceUpdatedAt}"]`) });
    await expect(source).toHaveCount(1);
    await source.click();
    await expect(transcript.getByText("third W6 message", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await openHistoryPanel(page);
    const labels = page.getByRole("region", { name: "Labels" });
    await expect(labels.getByText("W6 checkpoint", { exact: true })).toBeVisible();
    await expect(labels.getByText("1 label", { exact: true })).toBeVisible();

    await page.reload();
    await expect(options).toHaveCount(2, { timeout: 60_000 });
    const forked = options.filter({
      hasNot: page.locator(`time[datetime="${sourceUpdatedAt}"]`),
    });
    await expect(forked).toHaveCount(1);
    await forked.click();
    await expect(transcript.getByText("first W6 message", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(transcript.getByText("second W6 message", { exact: true })).toBeVisible();
    await expect(transcript.getByText("third W6 message", { exact: true })).toHaveCount(0);
    await openHistoryPanel(page);
    await expect(
      page.getByRole("region", { name: "Labels" }).getByText("W6 checkpoint"),
    ).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
