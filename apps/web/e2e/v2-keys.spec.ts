import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, type RealApp, realTest } from "./real-omp";

/** The new UI's in-chat keys (`apps/ui`, under `/v2/`) on real omp, as Tern's: history, chips, retry, folds, approvals. */
realTest.describe("new UI chat keys", () => {
  realTest.setTimeout(240_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });

  async function newChat(realApp: RealApp): Promise<Page> {
    const page = await realApp.open({ path: "/" });
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    return page;
  }

  async function send(page: Page, text: string): Promise<void> {
    await box(page).fill(text);
    await box(page).press("Enter");
  }

  realTest(
    "Up and Down go through what was sent and back to what was typed",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await send(page, "first question");
      await expect(transcript(page).getByText("pong")).toHaveCount(1, { timeout: 60_000 });
      await send(page, "second question");
      await expect(transcript(page).getByText("pong")).toHaveCount(2, { timeout: 60_000 });

      await box(page).fill("half typed");
      await box(page).press("Home");
      await box(page).press("ArrowUp");
      await expect(box(page)).toHaveValue("second question");
      await box(page).press("ArrowUp");
      await expect(box(page)).toHaveValue("first question");
      await box(page).press("ArrowUp");
      await expect(box(page)).toHaveValue("first question");
      await box(page).press("ArrowDown");
      await expect(box(page)).toHaveValue("second question");
      await box(page).press("ArrowDown");
      await expect(box(page)).toHaveValue("half typed");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Shift+Tab changes the thinking level, Alt+P opens the model list, Alt+R retries a failed turn",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      const thinking = page.getByRole("button", { name: /^Thinking: / });
      const before = await thinking.getAttribute("aria-label");
      await box(page).press("Shift+Tab");
      await expect(thinking).not.toHaveAttribute("aria-label", before ?? "");

      await box(page).press("Alt+p");
      await expect(page.getByPlaceholder("Find a model")).toBeVisible();
      await page.keyboard.press("Escape");

      await send(page, "provider_failure_long");
      await expect(page.getByText("The request failed")).toHaveCount(1, { timeout: 60_000 });
      await box(page).press("Alt+r");
      await expect(page.getByText("The request failed")).toHaveCount(2, { timeout: 60_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Ctrl+O opens and folds every tool card; Ctrl+T shows and hides thinking",
    async ({ realApp }) => {
      const page = await newChat(realApp);
      await send(page, `call_tool bash ${JSON.stringify({ command: "echo folded-output" })}`);
      const card = transcript(page).getByRole("button", { name: /^bash/ });
      await expect(card).toHaveAttribute("aria-expanded", "false", { timeout: 60_000 });
      await box(page).press("Control+o");
      await expect(card).toHaveAttribute("aria-expanded", "true");
      await box(page).press("Control+o");
      await expect(card).toHaveAttribute("aria-expanded", "false");

      await send(page, "stream_reasoning");
      const thoughts = transcript(page).getByRole("button", { name: "thinking" });
      await expect(thoughts.last()).toHaveAttribute("aria-expanded", "false", { timeout: 60_000 });
      await box(page).press("Control+t");
      await expect(thoughts.last()).toHaveAttribute("aria-expanded", "true");
      await box(page).press("Control+t");
      await expect(thoughts.last()).toHaveAttribute("aria-expanded", "false");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "an approval: Ctrl+Enter in the message box approves it, Esc denies the next",
    async ({ realApp }) => {
      await appendFile(
        join(realApp.agentDir, "config.yml"),
        "\ntools:\n  approvalMode: always-ask\n",
      );
      const page = await newChat(realApp);
      const approval = page.getByRole("dialog", { name: "Allow tool: write" });

      await send(
        page,
        `call_tool write ${JSON.stringify({ path: "notes/a.txt", content: "one\n" })}`,
      );
      await expect(approval).toBeVisible({ timeout: 60_000 });
      await box(page).press("Control+Enter");
      await expect(approval).toBeHidden();
      await expect(page.getByText(/^tool said: /)).toHaveCount(1, { timeout: 60_000 });
      expect(await readFile(join(realApp.folder, "notes/a.txt"), "utf8")).toBe("one\n");

      await send(
        page,
        `call_tool write ${JSON.stringify({ path: "notes/b.txt", content: "two\n" })}`,
      );
      await expect(approval).toBeVisible({ timeout: 60_000 });
      await box(page).press("Escape");
      await expect(approval).toBeHidden();
      await expect(page.getByText(/^tool said: /)).toHaveCount(2, { timeout: 60_000 });
      await expect(readFile(join(realApp.folder, "notes/b.txt"), "utf8")).rejects.toThrow();

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("Alt+Up takes the last queued message back into the box", async ({ realApp }) => {
    const page = await newChat(realApp);
    await send(page, "stream_steady");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 60_000 });
    await box(page).fill("for later");
    await box(page).press("Control+Enter");
    const queued = page.getByRole("list", { name: "Queued messages" });
    await expect(queued).toContainText("for later");
    await expect(box(page)).toHaveValue("");
    await box(page).press("Alt+ArrowUp");
    await expect(box(page)).toHaveValue("for later");
    await expect(queued).toHaveCount(0);

    expect(realApp.problems).toEqual([]);
  });
});
