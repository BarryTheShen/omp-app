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
 * #828 and #842 on real omp: while a message is edited, the edit box takes the place of the main composer, so one
 * composer is on screen, and the edit box is named 'Edit message' (the main composer keeps 'Message input').
 */

/** A transcript row by its role, found by the text it shows. */
function row(page: Page, role: "user" | "assistant", text: string) {
  return page.locator(`[data-slot="u1-message-row"][data-role="${role}"]`, { hasText: text });
}

/** The answer a `count_reply <tag>` prompt gets, by its tag. */
function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

async function openEdit(page: Page): Promise<void> {
  const first = row(page, "user", "count_reply first");
  await first.hover();
  await first.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Edit message" })).toBeFocused();
}

realTest(
  "while a message is edited, the edit box is the only composer on screen and has its own name",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "count_reply first");
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });

    await openEdit(page);
    // One composer: the main composer's text box and send are not on screen; the edit box's send is.
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Editing an earlier message" })).toBeVisible();
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "fix-828-842-edit-light.png"),
      fullPage: true,
    });

    // Cancel gives the main composer back, and the edit box goes.
    await page.getByRole("button", { name: "Cancel edit" }).click();
    await expect(page.getByRole("textbox", { name: "Edit message" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();

    // Dark: a reload keeps the chat; the edit opens again.
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });
    await openEdit(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-828-842-edit-dark.png"), fullPage: true });

    // 390 px, still editing: the one composer fits the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("textbox", { name: "Edit message" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
    const editor = await page
      .getByRole("region", { name: "Editing an earlier message" })
      .boundingBox();
    expect((editor?.x ?? 0) + (editor?.width ?? 0)).toBeLessThanOrEqual(390);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-828-842-edit-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
