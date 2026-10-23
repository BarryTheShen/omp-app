import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 2099. A chat whose turn runs stays in the list as a running row. After the person leaves its folder and comes
 * back, the row's title is a button, but a click on the rest of the row (between the title and the More actions button)
 * opened nothing and showed no error. A saved row opened on a click anywhere in its body, and a running row now does too.
 * The More actions button still opens its menu, and that click does not open the chat.
 */

const TRANSCRIPT = "Conversation transcript";
const PROMPT = "stream_held please answer";

/** Leaves the folder for the other one and comes back, as a person does with the workspace folder picker. */
async function leaveAndReturn(page: Page, folder: string, other: string): Promise<void> {
  const picker = page.getByRole("combobox", { name: "Workspace folder" });
  await picker.selectOption("__other__");
  await page.getByRole("textbox", { name: "Other folder path" }).fill(other);
  await page.getByRole("button", { name: "Use" }).click();
  await expect(picker).toHaveValue(other, { timeout: 30_000 });
  await expect(page.locator('[data-slot="r1-running-row"]')).toHaveCount(0, { timeout: 30_000 });
  await picker.selectOption("__other__");
  await page.getByRole("textbox", { name: "Other folder path" }).fill(folder);
  await page.getByRole("button", { name: "Use" }).click();
  await expect(picker).toHaveValue(folder, { timeout: 30_000 });
}

/** A point on a row's body: the middle of the gap between its title button and its More actions button. */
function bodyPoint(row: Locator) {
  return row.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const title = element.querySelector("button");
    const more = element.querySelector('button[title="More actions"]');
    if (title === null || more === null)
      throw new Error("The row has no title button or no More actions button.");
    const left = title.getBoundingClientRect().right;
    const right = more.getBoundingClientRect().left;
    const x = (left + right) / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x: x - box.left,
      y: y - box.top,
      gap: right - left,
      onBody: hit !== null && element.contains(hit) && hit.closest("button") === null,
    };
  });
}

/** Starts a chat whose reply holds after a few lines, until the release file is written. */
async function startHeldChat(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, PROMPT);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 60_000,
  });
}

realTest(
  "a running row opens its chat from its body, beside the title (issue 2099)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await startHeldChat(page);
    await leaveAndReturn(page, realApp.folder, realApp.otherFolder);

    const running = page.locator('[data-slot="r1-running-row"]').first();
    await expect(running).toBeVisible({ timeout: 30_000 });
    const point = await bodyPoint(running);
    expect(point.gap).toBeGreaterThan(0);
    expect(point.onBody).toBe(true);
    await running.click({ position: { x: point.x, y: point.y } });

    const transcript = page.getByRole("region", { name: TRANSCRIPT });
    await expect(transcript.getByText(PROMPT, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

    await writeFile(join(realApp.agentDir, "release-held-reply"), "go\n");
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 60_000,
    });
  },
);

realTest(
  "a running row's More actions button opens its menu, and the chat stays closed (issue 2099)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await startHeldChat(page);
    await leaveAndReturn(page, realApp.folder, realApp.otherFolder);

    const running = page.locator('[data-slot="r1-running-row"]').first();
    await expect(running).toBeVisible({ timeout: 30_000 });
    await running.locator('button[title="More actions"]').click();
    await expect(page.getByRole("menu", { name: "Actions for New chat" })).toBeVisible();
    // A chat that opened by mistake would open within moments: wait for that before checking it stayed closed.
    await page.waitForTimeout(2000);
    await expect(
      page.getByRole("region", { name: TRANSCRIPT }).getByText(PROMPT, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("menu", { name: "Actions for New chat" })).toBeVisible();

    await page.keyboard.press("Escape");
    await writeFile(join(realApp.agentDir, "release-held-reply"), "go\n");
    await expect(page.locator('[data-slot="r1-running-row"]')).toHaveCount(0, {
      timeout: 60_000,
    });
  },
);

realTest(
  "a saved row still opens its chat from its body (issue 2099)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "pong please");
    const transcript = page.getByRole("region", { name: TRANSCRIPT });
    await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-slot="r1-running-row"]')).toHaveCount(0, {
      timeout: 60_000,
    });
    await leaveAndReturn(page, realApp.folder, realApp.otherFolder);

    const saved = page.locator('[data-slot="r1-session-row"]').first();
    await expect(saved).toBeVisible({ timeout: 30_000 });
    const point = await bodyPoint(saved);
    expect(point.gap).toBeGreaterThan(0);
    expect(point.onBody).toBe(true);
    await saved.click({ position: { x: point.x, y: point.y } });
    await expect(transcript.getByText("pong please", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  },
);
