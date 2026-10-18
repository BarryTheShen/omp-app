import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 18, 11, 0, 0);
type RetryRecovery =
  | {
      readonly kind: "auto-retry";
      readonly status: "recovered";
      readonly attempt: number;
      readonly recoveredAt: string;
      readonly recovery: string;
      readonly note: string;
      readonly supersededBy: {
        readonly timestamp: string;
        readonly provider: string;
        readonly model: string;
      };
    }
  | {
      readonly kind: "auto-retry";
      readonly status: "superseded";
      readonly attempt: number;
      readonly recovery: string;
      readonly note: string;
    };

const recoveredRetry: RetryRecovery = {
  kind: "auto-retry",
  status: "recovered",
  attempt: 1,
  recoveredAt: new Date(at + 2_000).toISOString(),
  recovery: "wait",
  note: "rate-limited; waited; retried",
  supersededBy: {
    timestamp: new Date(at + 3_000).toISOString(),
    provider: "fake",
    model: "fake-model",
  },
};
const supersededRetry: RetryRecovery = {
  kind: "auto-retry",
  status: "superseded",
  attempt: 1,
  recovery: "wait",
  note: "error; retried",
};

const user = (id: string, text: string, timestamp: number, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  message: {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  },
});
const assistant = (
  id: string,
  text: string,
  timestamp: number,
  parentId: string,
  retryRecovery?: RetryRecovery,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage,
    stopReason: retryRecovery?.status === "recovered" ? "error" : "stop",
    timestamp,
    ...(retryRecovery === undefined ? {} : { retryRecovery }),
  },
});

realTest.use({
  seedEntries: {
    entries: [
      user("user-one", "First question", at, null),
      assistant("recovered", "Recovered answer", at + 1_000, "user-one", recoveredRetry),
      user("user-two", "Second question", at + 4_000, "recovered"),
      assistant("normal", "Normal answer", at + 5_000, "user-two"),
      user("user-three", "Third question", at + 6_000, "normal"),
      assistant("superseded", "Superseded answer", at + 7_000, "user-three", supersededRetry),
    ],
  },
});

async function openSeededChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  const transcript = page.getByRole("region", { name: "Conversation transcript" });
  await expect(transcript.getByText("Recovered answer", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const recoveredRow = transcript
    .getByText("Recovered answer", { exact: true })
    .locator("xpath=ancestor::*[@data-slot='u1-message-row']");
  const normalRow = transcript
    .getByText("Normal answer", { exact: true })
    .locator("xpath=ancestor::*[@data-slot='u1-message-row']");
  const supersededRow = transcript
    .getByText("Superseded answer", { exact: true })
    .locator("xpath=ancestor::*[@data-slot='u1-message-row']");
  await expect(recoveredRow.locator('[data-ending="retry-recovery"]')).toHaveCount(1);
  await expect(normalRow.locator('[data-ending="retry-recovery"]')).toHaveCount(0);
  await expect(supersededRow.locator('[data-ending="retry-recovery"]')).toHaveCount(0);
  await expect(page.locator('[data-ending="retry-recovery"]')).toHaveCount(1);
  await expect(
    transcript.getByText("rate-limited; waited; retried", { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByText("error; retried", { exact: true })).toHaveCount(0);
}

realTest("a recovered retry note appears only under the recovered answer", async ({ realApp }) => {
  const page = await realApp.open();
  await openSeededChat(page);
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1269-retry-recovery-light.png"),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1269-retry-recovery-dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1269-retry-recovery-narrow.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
