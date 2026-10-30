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
});
