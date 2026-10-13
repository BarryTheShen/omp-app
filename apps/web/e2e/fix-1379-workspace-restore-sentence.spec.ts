import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1379 on real omp. Every edit and every regenerate used to end its notice with "Workspace files were not
 * restored.", although no restore is ever attempted: the app mounts no checkpoint decorator, and omp's branch only
 * moves the conversation. The notice now says nothing about files that no restore touched. The fake model answers
 * `count_reply <tag>` with `count-<n> <tag>`, so an answer given again is visibly new.
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

/** The notice a run left in the chat it touched: it names the branch. */
function branchNotice(page: Page) {
  return page.getByRole("status").filter({ hasText: "branched from" });
}

realTest.describe("the notice after an edit or a regenerate", () => {
  realTest(
    "an edit's notice says the chat was branched, and says nothing about files no restore touched",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      await page.setViewportSize({ width: 1280, height: 900 });
      const composer = await startChat(page);
      await sendPrompt(composer, "count_reply first");
      await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });

      const firstTurn = row(page, "user", "count_reply first");
      await firstTurn.hover();
      await firstTurn.getByRole("button", { name: "Edit", exact: true }).click();
      const editorInput = editor(page).getByRole("textbox", { name: "Edit message" });
      await expect(editorInput).toBeFocused();
      await editorInput.fill("count_reply second");
      await editorInput.press("Enter");

      await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
      const notice = branchNotice(page);
      await expect(notice).toContainText("Sent in this new chat, branched from the original.");
      await expect(notice).not.toContainText("not restored");

      await mkdir(screenshots, { recursive: true });
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-1379-edit-light.png") });
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-1379-edit-dark.png") });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      // At 390 px both sidebars are drawers: wait until both report closed before the narrow capture.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("inert", "");
      await expect(page.locator("#shell-panels-sidebar")).toHaveAttribute("inert", "");
      await expect(page.locator('[data-shell-drawer-backdrop="true"]')).toHaveCount(0);
      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, "fix-1379-edit-narrow.png") });
    },
  );

  realTest(
    "a regenerate's notice says the answer was asked again, and says nothing about files no restore touched",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      await page.setViewportSize({ width: 1280, height: 900 });
      const composer = await startChat(page);
      await sendPrompt(composer, "count_reply first");
      const firstAnswer = answerTo(page, "first");
      await expect(firstAnswer).toBeVisible({ timeout: 60_000 });
      const firstCount = counterOf(await firstAnswer.textContent());

      const reply = row(page, "assistant", `count-${firstCount} first`);
      await reply.hover();
      await reply.getByRole("button", { name: "Regenerate response" }).click();
      await expect
        .poll(async () => counterOf(await answerTo(page, "first").textContent()), {
          timeout: 60_000,
        })
        .toBeGreaterThan(firstCount);

      const notice = branchNotice(page);
      await expect(notice).toContainText("Answered again");
      await expect(notice).not.toContainText("not restored");
    },
  );
});
