import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

/**
 * The omp binary the fixture runs (see real-omp.ts). This wrapper makes a new chat wait 4 s before omp starts and
 * starts a resumed chat at once. So a New chat clicked and then a chat picked finishes its pick first, while the New
 * chat is still opening: the sequence the fix for #877 must keep. Without the wait the race is too short to test.
 */
const REAL_OMP = "/home/user/.bun/bin/omp";
const delayDir = resolve(process.cwd(), "../../.data/fix-877-new-chat");
mkdirSync(delayDir, { recursive: true });
const delayedOmp = join(delayDir, "omp-new-chat-delay.sh");
writeFileSync(
  delayedOmp,
  `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then exec "${REAL_OMP}" "$@"; fi
done
sleep 4
exec "${REAL_OMP}" "$@"
`,
);
chmodSync(delayedOmp, 0o755);
realTest.use({ ompBinary: delayedOmp });

function newChatButton(page: Page): Locator {
  return page.locator('[aria-label="Sessions"]').getByRole("button", { name: "New chat" }).first();
}

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

/**
 * Issue #877, the second click. New chat, then a chat picked from the list, then New chat again: the last click is the
 * one the person wants, so the new chat must open. The second New chat must not share the first one, which was
 * superseded by the pick.
 */
realTest("New chat, a pick, then New chat again ends on the new chat", async ({ realApp }) => {
  const page = await realApp.open();
  const first = await startChat(page);
  await sendPrompt(first, "pick target");
  await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
    timeout: 90_000,
  });

  const other = await startChat(page);
  await sendPrompt(other, "other chat");
  await expect(transcript(page).getByText("other chat", { exact: true })).toBeVisible({
    timeout: 90_000,
  });

  // The first New chat is still opening when the pick finishes; the second New chat is clicked after the pick.
  await newChatButton(page).click();
  await sessionList(page)
    .getByRole("option", { name: /pick target/ })
    .click();
  await expect(transcript(page).getByText("pick target", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await newChatButton(page).click();

  await expect(transcript(page).getByText("pick target", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(composer(page)).toHaveValue("", { timeout: 60_000 });
  await expect(
    sessionList(page).getByRole("option", { name: /pick target/, selected: true }),
  ).toHaveCount(0);
});
