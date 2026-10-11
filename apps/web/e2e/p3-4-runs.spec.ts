import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import {
  APP_ROOT,
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * A `count_reply <tag>` answer reads `count-<n> <tag>`: the counter rises across the fake server, so an
 * answer given again is visibly new (packages/omp-rpc/scripts/fake-openai-server.ts). The counter is
 * compared, never matched exactly, because omp may make its own model calls in between.
 */
function counterOf(text: string | null): number {
  const match = /^count-(\d+) /.exec(text ?? "");
  if (match?.[1] === undefined) throw new Error(`Not a counted answer: ${text ?? "(none)"}`);
  return Number(match[1]);
}

/** A transcript row by its role, found by the text it shows. */
function row(page: Page, role: "user" | "assistant", text: string) {
  return page.locator(`[data-slot="u1-message-row"][data-role="${role}"]`, { hasText: text });
}

/** The editing surface, which is the only region named for the edit. */
function editor(page: Page) {
  return page.getByRole("region", { name: "Editing an earlier message" });
}

/** The answer a `count_reply <tag>` prompt gets, by its tag. */
function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

/**
 * A stand-in omp that does not know the branch command. The app probes each command by sending it and
 * reading whether omp answers "Unknown command:"; this one answers only `branch` that way and forwards
 * every other line to the real omp, so the probe finds branch missing and nothing else changes.
 */
const OMP_WITHOUT_BRANCH = join(APP_ROOT, ".data", "p3-4-e2e", "omp-without-branch");
const WRAPPER_SOURCE = [
  "#!/usr/bin/env bun",
  "// Stand-in omp: answers the branch command as unknown and forwards every other line to the real omp.",
  'import { spawn } from "node:child_process";',
  'import { createInterface } from "node:readline";',
  'const realOmp = "/home/user/.bun/bin/omp";',
  "const child = spawn(realOmp, process.argv.slice(2), {",
  "  env: process.env,",
  '  stdio: ["pipe", "pipe", "inherit"],',
  "});",
  "child.stdout.pipe(process.stdout);",
  "child.on('exit', (code) => process.exit(code ?? 1));",
  "process.on('SIGTERM', () => child.kill('SIGTERM'));",
  "process.on('SIGINT', () => child.kill('SIGINT'));",
  "const lines = createInterface({ input: process.stdin });",
  "lines.on('close', () => child.stdin.end());",
  "lines.on('line', (line) => {",
  "  let command;",
  "  try {",
  "    command = JSON.parse(line);",
  "  } catch {",
  "    child.stdin.write(line + '\\n');",
  "    return;",
  "  }",
  "  if (command !== null && typeof command === 'object' && command.type === 'branch') {",
  "    const error = { id: command.id, type: 'response', command: 'branch', success: false, error: 'Unknown command: branch' };",
  "    process.stdout.write(JSON.stringify(error) + '\\n');",
  "    return;",
  "  }",
  "  child.stdin.write(line + '\\n');",
  "});",
  "",
].join("\n");

// The fixture starts the server before a test body runs, so the stand-in must exist when this file loads.
mkdirSync(dirname(OMP_WITHOUT_BRANCH), { recursive: true });
writeFileSync(OMP_WITHOUT_BRANCH, WRAPPER_SOURCE);
chmodSync(OMP_WITHOUT_BRANCH, 0o755);

realTest.describe("edit and regenerate from the transcript", () => {
  realTest(
    "edits a message onto a new reply, asks the reply again, and cancels or submits without losing the draft",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      await page.setViewportSize({ width: 1280, height: 900 });
      const composer = await startChat(page);

      await sendPrompt(composer, "count_reply first");
      const firstAnswer = answerTo(page, "first");
      await expect(firstAnswer).toBeVisible({ timeout: 60_000 });
      const firstCount = counterOf(await firstAnswer.textContent());

      // A draft typed but not sent must survive an edit.
      await composer.fill("draft kept");

      // Edit the message: the editor opens with its exact text, focused; submitting sends the edit.
      const firstTurn = row(page, "user", "count_reply first");
      await firstTurn.hover();
      await firstTurn.getByRole("button", { name: "Edit", exact: true }).click();
      const editorInput = editor(page).getByRole("textbox", { name: "Edit message" });
      await expect(editor(page)).toBeVisible();
      await expect(editorInput).toHaveValue("count_reply first");
      await expect(editorInput).toBeFocused();
      await editorInput.fill("count_reply second");
      await editorInput.press("Enter");

      // The transcript shows the new text and a fresh reply, and the editor is gone.
      const secondAnswer = answerTo(page, "second");
      await expect(secondAnswer).toBeVisible({ timeout: 60_000 });
      const secondCount = counterOf(await secondAnswer.textContent());
      expect(secondCount).toBeGreaterThan(firstCount);
      await expect(row(page, "user", "count_reply second")).toBeVisible();
      await expect(firstAnswer).toHaveCount(0);
      await expect(editor(page)).toHaveCount(0);
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Sent in this new chat, branched from the original." }),
      ).toBeVisible();

      // The status control opens the original chat: its first answer, its draft, no edited text.
      await page.getByRole("button", { name: "Open the original chat" }).click();
      await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue("draft kept");
      await expect(answerTo(page, "first")).toBeVisible();
      await expect(answerTo(page, "second")).toHaveCount(0);
      await expect(firstTurn.getByRole("button", { name: "Edit", exact: true })).toBeVisible();

      // The sidebar switches back to the branch, which loads from omp's history with its answer.
      await page.getByRole("option", { name: /count_reply second/ }).click();
      await expect(answerTo(page, "second")).toBeVisible();
      await expect(answerTo(page, "first")).toHaveCount(0);
      // The branch's composer starts empty: the draft typed in the original chat stays with that chat.
      await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue("");

      // The sidebar opens the original again, and its Edit control opens and cancels the editor.
      await page.getByRole("option", { name: /count_reply first/ }).click();
      await expect(answerTo(page, "first")).toBeVisible();
      await firstTurn.hover();
      await firstTurn.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(editor(page)).toBeVisible();
      await editor(page).getByRole("button", { name: "Cancel edit" }).click();
      await expect(editor(page)).toHaveCount(0);

      // Back to the branch from the session list, where the rest of the flow runs.
      await page.getByRole("option", { name: /count_reply second/ }).click();
      await expect(answerTo(page, "second")).toBeVisible();

      // Regenerate the reply: a new reply, the old one gone from this chat.
      const secondTurn = row(page, "assistant", `count-${secondCount} second`);
      await secondTurn.hover();
      await secondTurn.getByRole("button", { name: "Regenerate response" }).click();
      await expect
        .poll(async () => counterOf(await answerTo(page, "second").textContent()), {
          timeout: 60_000,
        })
        .toBeGreaterThan(secondCount);
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Answered again in this new chat, branched from the original." }),
      ).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue("");
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "p3-4-regenerated-light.png") });

      // Cancel closes the editor and returns focus to the row's Edit button.
      const secondUser = row(page, "user", "count_reply second");
      const secondEdit = secondUser.getByRole("button", { name: "Edit", exact: true });
      await secondUser.hover();
      await secondEdit.click();
      await expect(editor(page)).toBeVisible();
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "p3-4-editor-light.png") });
      await editor(page).getByRole("button", { name: "Cancel edit" }).click();
      await expect(editor(page)).toHaveCount(0);
      await expect(secondEdit).toBeFocused();

      // Escape cancels too.
      await secondEdit.click();
      await expect(editor(page)).toBeVisible();
      await editor(page).getByRole("textbox", { name: "Edit message" }).press("Escape");
      await expect(editor(page)).toHaveCount(0);
      await expect(secondEdit).toBeFocused();

      // Narrow layout: the controls are visible without hovering, and the editor fits.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(secondEdit).toBeVisible();
      await secondEdit.click();
      await expect(editor(page)).toBeVisible();
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "p3-4-editor-narrow.png") });
    },
  );

  realTest(
    "two messages sent back to back stay in order, and each shows its controls",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      await page.setViewportSize({ width: 1280, height: 900 });
      const composer = await startChat(page);

      await sendPrompt(composer, "count_reply queue-one");
      // Ctrl+Enter queues the second message as a follow-up while the first turn streams; if that turn
      // has already ended, it is sent at once. Either way the transcript keeps the order.
      await composer.fill("count_reply queue-two");
      await composer.press("Control+Enter");
      await expect(answerTo(page, "queue-two")).toBeVisible({ timeout: 90_000 });

      const rows = page.locator('[data-slot="u1-message-row"]');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).toContainText("count_reply queue-one");
      await expect(rows.nth(1)).toContainText("queue-one");
      await expect(rows.nth(2)).toContainText("count_reply queue-two");
      await expect(rows.nth(3)).toContainText("queue-two");
      await expect(rows.nth(0).getByRole("button", { name: "Edit", exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(rows.nth(1).getByRole("button", { name: "Regenerate response" })).toBeVisible({
        timeout: 60_000,
      });
      await expect(rows.nth(2).getByRole("button", { name: "Edit", exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(rows.nth(3).getByRole("button", { name: "Regenerate response" })).toBeVisible({
        timeout: 60_000,
      });
    },
  );

  realTest("the editor in dark mode", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    const composer = await startChat(page);
    await sendPrompt(composer, "count_reply dark");
    await expect(answerTo(page, "dark")).toBeVisible({ timeout: 60_000 });

    const turn = row(page, "user", "count_reply dark");
    await turn.hover();
    await turn.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(editor(page)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "p3-4-editor-dark.png") });
  });
});

realTest.describe("an omp without the branch command", () => {
  realTest.use({ ompBinary: OMP_WITHOUT_BRANCH });

  realTest("shows neither Edit nor Regenerate", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "count_reply plain");
    await expect(answerTo(page, "plain")).toBeVisible({ timeout: 60_000 });

    await expect(row(page, "user", "count_reply plain")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Regenerate response" })).toHaveCount(0);
  });
});
