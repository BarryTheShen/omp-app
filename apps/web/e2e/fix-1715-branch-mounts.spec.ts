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

function editor(page: Page) {
  return page.getByRole("region", { name: "Editing an earlier message" });
}

async function openEarlierMessageSelector(page: Page): Promise<void> {
  const opener = page.getByRole("button", { name: "Edit an earlier message" });
  await expect(opener).toBeVisible({ timeout: 20_000 });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option", { name: /count_reply first/ })).toBeVisible();
  await dialog.getByRole("option", { name: /count_reply first/ }).click();
  await dialog.getByRole("button", { name: "Choose" }).click();
}

realTest("mounts the earlier-message selector in a real chat", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(360_000);
  const page = await realApp.open();
  await page.setViewportSize({ width: 1280, height: 900 });
  const composer = await startChat(page);
  await sendPrompt(composer, "count_reply first");
  await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });

  await openEarlierMessageSelector(page);
  const editorInput = editor(page).getByRole("textbox", { name: "Edit message" });
  await expect(editorInput).toHaveValue("count_reply first");
  await editorInput.fill("count_reply second");
  await editorInput.press("Enter");
  await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });

  await expect(page.getByRole("option", { name: /count_reply second/ })).toBeVisible();

  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1715-branch-mounts-light.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1715-branch-mounts-dark.png") });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1715-branch-mounts-narrow.png") });
  expect(realApp.problems).toEqual([]);
});
