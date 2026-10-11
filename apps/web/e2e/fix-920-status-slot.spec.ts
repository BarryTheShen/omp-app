import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

/**
 * Issue #920. The debug log's save confirmation is a short message over the top of the chat. It must not change the
 * header's height, so the chat stays where it was when the message appears.
 */
realTest(
  "saving the debug log shows its confirmation without moving the chat down",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "chat with a reply");
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
    const before = await transcript.boundingBox();
    expect(before).not.toBeNull();

    // 'Save debug log' in the palette downloads the log; the confirmation then shows over the chat.
    await composer.focus();
    await page.keyboard.press("Control+k");
    const downloadStarted = page.waitForEvent("download");
    await page.getByRole("option", { name: /Save debug log/ }).click();
    await downloadStarted;
    await expect(page.getByText(/Saved omp-app-debug-.*\.log to your downloads/)).toBeVisible();

    // The chat has not moved: the transcript starts where it did before the confirmation appeared.
    const after = await transcript.boundingBox();
    expect(after?.y).toBeCloseTo(before?.y ?? Number.NaN, 0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-920-status-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-920-status-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-920-status-narrow.png") });
  },
);
