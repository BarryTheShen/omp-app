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

/** The bash card of the command the fake model runs (`slow_tool`: a 7 second sleep). */
function bashCard(page: Page) {
  return page.getByTestId("u3-bash-card").first();
}

/** Once the stopped turn has settled, the card reads Cancelled: no Error header, no alert, no omp abort text. */
async function expectStoppedCard(page: Page): Promise<void> {
  await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
  await expect(bashCard(page).getByRole("button", { name: "bash: Cancelled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "bash: Error" })).toHaveCount(0);
  await expect(bashCard(page).getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Command aborted")).toHaveCount(0);
}

realTest(
  "Escape stops a running bash command, and its card reads Cancelled, not Error (light, dark, 390 px, and after a reload)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "slow_tool stop");
    await expect(bashCard(page).getByRole("button", { name: "bash: Running" })).toBeVisible({
      timeout: 60_000,
    });

    await composer.press("Escape");
    await expectStoppedCard(page);
    await page.screenshot({ path: join(screenshots, "fix-1061-stopped-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1061-stopped-dark.png") });

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1061-stopped-390.png") });

    // Reopening the chat reads the history: the same card, the same word.
    await page.reload();
    await expectStoppedCard(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Stop generating button stops a running bash command, and its card reads Cancelled, not Error",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "slow_tool stop");
    await expect(bashCard(page).getByRole("button", { name: "bash: Running" })).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole("button", { name: "Stop generating" }).click();
    await expectStoppedCard(page);
    expect(realApp.problems).toEqual([]);
  },
);
