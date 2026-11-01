import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest } from "./real-omp";

/** The new UI's transcript (`apps/ui`, under `/v2/`) on real omp: a failed request and what it offers. */
realTest.describe("new UI transcript", () => {
  realTest.setTimeout(240_000);

  async function newChat(realApp: RealApp): Promise<Page> {
    const page = await realApp.open({ path: "/" });
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
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
