import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * #1060: a reader who scrolls up in a long chat and sends a message sees the new message and omp's reply, and
 * "Jump to latest message" goes away. The chat is 60 question and answer pairs; the fake model answers "pong".
 */

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const PAIRS = 60;
const seeded = Array.from({ length: PAIRS }, (_, index) => [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `Question ${index + 1}` }],
      timestamp: Date.UTC(2026, 9, 4) + index * 60_000,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `Answer ${index + 1}, line one.\n\nAnswer ${index + 1}, line two.` },
      ],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: Date.UTC(2026, 9, 4) + index * 60_000 + 1_000,
    },
  },
]).flat();

const MESSAGE = "after scroll reader";

realTest.use({ seedEntries: { entries: seeded } });

/** Scrolls the long chat up, sends a message, and checks that the message and the reply are in view at the end. */
async function sendFromFarUp(page: Page, shot: string): Promise<void> {
  const thread = page.getByRole("region", { name: "Messages" });
  const composer = page.getByRole("textbox", { name: "Message input" });
  const jump = page.getByRole("button", { name: "Jump to latest message" });
  const remainingScroll = () =>
    thread.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);

  await expect(thread.getByText("Answer 60, line two.", { exact: true })).toBeInViewport({
    timeout: 45_000,
  });
  await thread.hover();
  await page.mouse.wheel(0, -4_000);
  await expect(jump).toBeVisible({ timeout: 10_000 });
  await expect(thread.getByText("Answer 60, line two.", { exact: true })).not.toBeInViewport();

  await composer.fill(MESSAGE);
  await composer.press("Enter");

  await expect(thread.getByText(MESSAGE, { exact: true })).toBeInViewport({ timeout: 15_000 });
  await expect(thread.getByText("pong", { exact: true }).last()).toBeVisible({ timeout: 60_000 });
  await expect.poll(remainingScroll, { timeout: 20_000 }).toBeLessThan(80);
  await expect(thread.getByText(MESSAGE, { exact: true })).toBeInViewport();
  await expect(thread.getByText("pong", { exact: true }).last()).toBeInViewport();
  await expect(jump).toHaveCount(0);

  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, shot), animations: "disabled" });
}

realTest(
  "#1060 real omp: after a scroll up, a send shows the new message and the reply, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
      .getByRole("option", { name: /^Question 1/ })
      .first()
      .click();
    await sendFromFarUp(page, "fix-1060-send-follow-light.png");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1060 real omp: after a scroll up, a send shows the new message and the reply, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
      .getByRole("option", { name: /^Question 1/ })
      .first()
      .click();
    await sendFromFarUp(page, "fix-1060-send-follow-dark.png");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1060 real omp: after a scroll up, a send shows the new message and the reply, at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await page
      .getByRole("option", { name: /^Question 1/ })
      .first()
      .click();
    await sendFromFarUp(page, "fix-1060-send-follow-narrow.png");
    expect(realApp.problems).toEqual([]);
  },
);
