import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const at = Date.UTC(2026, 9, 18, 10, 0, 0);
const message = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(at).toISOString(),
  message: {
    role,
    content: [{ type: "text", text }],
    ...(role === "assistant"
      ? {
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        }
      : {}),
    timestamp: at,
  },
});

realTest.use({
  seedEntries: {
    entries: [
      message("old", null, "user", "This message was before clear."),
      {
        type: "reset_boundary",
        id: "clear",
        parentId: "old",
        timestamp: new Date(at + 1_000).toISOString(),
      },
      message("new", "clear", "user", "This message is after clear."),
    ],
  },
});

async function openSeededChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.getByText("This message is after clear.", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const transcript = page.getByRole("region", { name: "Conversation transcript" });
  await expect(transcript.getByText("This message was before clear.", { exact: true })).toHaveCount(
    0,
  );
}

realTest("a seeded chat hides entries before the latest reset boundary", async ({ realApp }) => {
  const page = await realApp.open();
  await openSeededChat(page);
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1268-reset-boundary-light.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});

realTest("a seeded chat after reset reads in dark", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
  });
  await openSeededChat(page);
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1268-reset-boundary-dark.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
