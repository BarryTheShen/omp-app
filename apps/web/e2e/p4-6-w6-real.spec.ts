import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

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
    const picker = page.getByRole("dialog", { name: "Choose where to rewind" });
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
    await expect(transcript.getByText("first W6 message", { exact: true })).toBeVisible();
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
