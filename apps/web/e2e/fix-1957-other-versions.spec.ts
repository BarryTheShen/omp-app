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

function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

async function editEarlierMessage(page: Page): Promise<void> {
  const opener = page.getByRole("button", { name: "Edit an earlier message" });
  await expect(opener).toBeVisible({ timeout: 20_000 });
  await opener.click();
  const dialog = page.getByRole("dialog");
  // The dialog opens only after omp has listed the chat's earlier messages (a request to the real omp), which can take
  // longer than the default five seconds on a busy machine: it failed 1 of 30 runs at the default.
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("option", { name: /count_reply first/ }).click();
  await dialog.getByRole("button", { name: "Choose" }).click();
  const editor = page.getByRole("region", { name: "Editing an earlier message" });
  const input = editor.getByRole("textbox", { name: "Edit message" });
  await expect(input).toHaveValue("count_reply first");
  await input.fill("count_reply second");
  await input.press("Enter");
  await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
}

realTest(
  "lists chats made from an edited message as Other versions",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(360_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "count_reply first");
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });
    await editEarlierMessage(page);
    await sendPrompt(page.getByRole("textbox", { name: "Message input" }), "count_reply third");
    await expect(answerTo(page, "third")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Other versions" })).toHaveCount(1);
    const action = page.getByRole("button", { name: "Other versions" });
    await expect(action).toBeVisible({ timeout: 60_000 });
    await action.click();
    const list = page.getByRole("list", { name: "Other versions" });
    await expect(list).toBeVisible();
    await expect(list.getByRole("button")).toHaveCount(1);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1957-other-versions-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1957-other-versions-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1957-other-versions-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
