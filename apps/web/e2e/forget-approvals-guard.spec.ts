import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #2633. omp 18.12.6's `/forget-approvals` deletes every file and folder approval "Ask and remember" recorded, and
 * runs at once. Like the other typed forms that delete saved data, the app asks first: Cancel sends nothing to omp, and
 * the destructive button sends the command once, after which omp's reply shows. The omp here runs in the test's own
 * agent folder, so nothing outside the test is forgotten whichever answer is given.
 */

const REPLY = "Remembered approvals forgotten; the next read or write asks again.";

/** The question the typed command opens: its accessible name is the form's label. */
function question(page: Page): Locator {
  return page.getByRole("dialog", { name: "Forget approvals" });
}

/** The `/` list above the composer, which omp's own list fills (omp 18.12.6 lists `/forget-approvals` itself). */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** omp's reply to a command, shown in the header. */
function commandReply(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: "omp:" });
}

/** The issue's steps: type the command, see omp's row for it in the list, press Enter. */
async function typeAndPressEnter(page: Page, composer: Locator): Promise<void> {
  await composer.fill("/forget-approvals");
  await expect(
    commandList(page).getByRole("option", { name: /^\/forget-approvals\b/ }),
    "omp's list offers the command",
  ).toBeVisible({ timeout: 60_000 });
  await composer.press("Enter");
}

async function capture(page: Page, name: string): Promise<void> {
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, `fix-2633-forget-approvals-${name}.png`),
    fullPage: true,
  });
}

realTest(
  "#2633: a typed /forget-approvals asks first; Cancel sends nothing to omp, and the destructive button sends it once (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);

    // Enter on the typed command opens the question, and omp has been sent nothing.
    await typeAndPressEnter(page, composer);
    await expect(question(page)).toBeVisible();
    await expect(question(page).getByText("Forget every remembered approval?")).toBeVisible();
    await expect(question(page).getByText(/file and folder approval it remembered/)).toBeVisible();
    await expect(commandReply(page)).toHaveCount(0);
    await capture(page, "light");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await capture(page, "dark");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "narrow");
    // Both buttons stay inside the box and the window on a narrow screen.
    const box = await question(page).boundingBox();
    if (box === null) throw new Error("the question has no box");
    for (const name of ["Cancel", "Forget approvals"]) {
      const button = await question(page).getByRole("button", { name, exact: true }).boundingBox();
      if (button === null) throw new Error(`the ${name} button has no box`);
      expect(button.x).toBeGreaterThanOrEqual(box.x);
      expect(button.x + button.width).toBeLessThanOrEqual(Math.min(box.x + box.width, 390));
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // Cancel sends nothing. A prompt sent after it is answered by omp in the same session, so once that answer shows,
    // a command sent before it has been answered too, and no reply to the command may be there.
    await question(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question(page)).toHaveCount(0);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(1);
    await expect(commandReply(page)).toHaveCount(0);

    // The destructive button sends the command once, and omp's reply shows in the header.
    await typeAndPressEnter(page, composer);
    await question(page).getByRole("button", { name: "Forget approvals", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `omp: ${REPLY}` })).toBeVisible({
      timeout: 30_000,
    });
    await expect(question(page)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
