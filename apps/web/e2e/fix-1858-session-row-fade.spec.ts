import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const timestamp = Date.UTC(2026, 9, 10, 9, 0, 0);
const entries: Record<string, unknown>[] = Array.from({ length: 40 }, (_, index) => [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `Question ${index + 1}: how do I keep the parser stable?` }],
      timestamp: timestamp + index * 2 * 60_000,
    },
  },
  {
    type: "message",
    message: {
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage: USAGE,
      timestamp: timestamp + (index * 2 + 1) * 60_000,
      role: "assistant",
      content: [{ type: "text", text: `Answer ${index + 1}. Keep the parser stable.` }],
      stopReason: "stop",
    },
  },
]).flat();

declare global {
  interface Window {
    __sessionFades?: string[];
  }
}

function recordSessionFades(): void {
  const fades: string[] = [];
  window.__sessionFades = fades;
  document.addEventListener(
    "transitionrun",
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.propertyName !== "opacity") return;
      if (event.target.matches('[data-slot="r1-session-row"]'))
        fades.push((event.target.textContent ?? "").replace(/\s+/g, " ").trim());
    },
    true,
  );
}

realTest.describe("a new session row fades in once", () => {
  realTest.use({ seedEntries: { entries } });

  for (const variant of ["light", "dark", "narrow"] as const) {
    realTest(
      `row 8: session list updates do not replay the new row fade (${variant})`,
      async ({ realApp }, testInfo) => {
        testInfo.setTimeout(180_000);
        const page = await realApp.open({
          beforeLoad: async (target) => {
            if (variant === "dark")
              await target.addInitScript(() =>
                window.localStorage.setItem("omp-app.theme", "dark"),
              );
            await target.addInitScript(recordSessionFades);
          },
        });
        const historyRow = page
          .getByRole("listbox", { name: "Session list" })
          .getByRole("option")
          .filter({ hasText: "Question 1" })
          .first();
        await expect(historyRow).toBeVisible({ timeout: 60_000 });
        await waitForFiniteAnimations(page);
        // The rows the first load lists are history: none of them fades in.
        expect(await page.evaluate(() => window.__sessionFades ?? [])).toEqual([]);
        await historyRow.click();
        await expect(
          page.getByText("Answer 40. Keep the parser stable.", { exact: true }),
        ).toBeVisible({ timeout: 60_000 });
        const composer = await startChat(page);
        await sendPrompt(composer, "pong");
        await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
          timeout: 60_000,
        });
        const newSessionRow = page
          .getByRole("listbox", { name: "Session list" })
          .getByRole("option")
          .filter({ hasText: "pong" })
          .first();
        await expect(newSessionRow).toBeVisible({ timeout: 60_000 });
        await historyRow.click();
        await expect(
          page.getByText("Answer 40. Keep the parser stable.", { exact: true }),
        ).toBeVisible({ timeout: 60_000 });
        await page.waitForTimeout(20_000);
        const fades = await page.evaluate(() => window.__sessionFades ?? []);
        const newRowFades = fades.filter((label) => label.startsWith("pong"));
        const historyFades = fades.filter((label) => label.startsWith("Question 1"));
        expect(historyFades, `history row fades: ${JSON.stringify(historyFades)}`).toEqual([]);
        expect(newRowFades.length, `new session row fades: ${JSON.stringify(fades)}`).toBe(1);
        if (variant === "narrow") {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.keyboard.press("Escape");
        }
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({
          path: join(screenshots, `fix-1858-${variant}.png`),
          fullPage: true,
        });
      },
    );
  }
});
