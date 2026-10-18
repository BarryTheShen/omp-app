import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/**
 * A user's own `!` run shows as a card: a header with how it ended, the command and the output. The
 * header needs the same arrow as the other collapsible parts (the "Thought" line and "earlier steps"):
 * it turns when the card is open and is back when the card is closed. The command and the output are
 * scroll regions, so a keyboard user can focus each and scroll it with the arrow keys. This runs a long
 * `!seq` on real omp, so the output is taller than its box.
 */

const RUN = '[data-slot="u1-execution-row"]';

/** The shell draws with the app's own background, not the browser's default: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

async function runLongCommand(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, `!seq 1 300; printf '%s\\n' '${"x".repeat(1_500)}'`);
  await expect(page.locator(RUN)).toBeVisible({ timeout: 60_000 });
}

realTest(
  "the bash card's arrow turns when it is open, and its output scrolls by keyboard",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await runLongCommand(page);

    const run = page.locator(RUN);
    const arrow = run.locator("summary > svg");
    await expect(arrow).toHaveCSS("rotate", "90deg");
    await run.locator("summary").click();
    await expect(run).toHaveJSProperty("open", false);
    await expect(arrow).toHaveCSS("rotate", "none");
    await run.locator("summary").click();
    await expect(run).toHaveJSProperty("open", true);
    await expect(arrow).toHaveCSS("rotate", "90deg");

    const command = page.getByRole("group", { name: "Command" });
    await command.focus();
    await expect(command).toBeFocused();

    const output = page.getByRole("group", { name: "Output" });
    await output.focus();
    await expect(output).toBeFocused();
    expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
    for (let press = 0; press < 6; press += 1) await page.keyboard.press("ArrowDown");
    await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await expectStylesLoaded(page);
    await mkdir(join(screenshots, "fix-864-bash-card"), { recursive: true });
    await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
      path: join(screenshots, "fix-864-bash-card", "light.png"),
    });
  },
);

realTest("the bash card reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open({
    beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await runLongCommand(page);
  await expect(page.locator(RUN).locator("summary > svg")).toHaveCSS("rotate", "90deg");
  await expectStylesLoaded(page);
  await mkdir(join(screenshots, "fix-864-bash-card"), { recursive: true });
  await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
    path: join(screenshots, "fix-864-bash-card", "dark.png"),
  });
});

realTest("the bash card fits a 390 px phone", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await runLongCommand(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("group", { name: "Output" })).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await expectStylesLoaded(page);
  await mkdir(join(screenshots, "fix-864-bash-card"), { recursive: true });
  await page.getByRole("region", { name: "Conversation transcript" }).screenshot({
    path: join(screenshots, "fix-864-bash-card", "narrow-390.png"),
  });
});
