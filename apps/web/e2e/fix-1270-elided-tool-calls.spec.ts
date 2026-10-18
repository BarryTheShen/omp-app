import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

realTest.setTimeout(300_000);
realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        message: {
          role: "user",
          content: "run two tools",
          timestamp: 1,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-one", name: "bash", arguments: { command: "pwd" } },
            { type: "toolCall", id: "call-two", name: "bash", arguments: { command: "ls" } },
          ],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage,
          stopReason: "stop",
          strippedToolCalls: 2,
          timestamp: 2,
        },
      },
    ],
  },
});

realTest(
  "real omp delivers the stripped-call count and finished branch note",
  async ({ realApp }, testInfo) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    const note = page.getByText("2 tool calls elided — no result on this branch");
    await expect(note).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /Working/ })).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1270-elided-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.emulateMedia({ colorScheme: "dark" });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1270-elided-dark.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
    testInfo.annotations.push({
      type: "omp-source",
      description: "v18.9.1 session-context.ts:703-728; stripped-tool-calls-placeholder.ts:16-18",
    });
  },
);
