/// <reference types="node" />
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
 * A tool card's summary in a worker's transcript, in the Agent Hub's side panel, against real omp (#1587). The
 * panel is narrow, so a collapsed card's summary used to be squeezed to a few letters beside its status chip. The
 * steerable worker here finishes after its bash steps and a yield; the first card with a summary is measured.
 */

const NARROW = { width: 390, height: 844 } as const;
/** A summary that keeps its words is at least this wide; squeezed beside the chip it was a few pixels. */
const MIN_SUMMARY_WIDTH = 120;

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function darkLook(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await settle(page);
}

realTest.setTimeout(420_000);

realTest(
  "a finished worker's card keeps its summary in the narrow Agents panel, in light, dark and narrow layouts",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub).toHaveAttribute("data-panel-lifecycle", "empty", { timeout: 90_000 });

    await sendPrompt(composer, "spawn_steerable_subagent start the worker and wait for it");
    await expect(hub.getByRole("option", { name: /Running/ })).toHaveCount(1, { timeout: 120_000 });
    await hub.getByRole("option", { name: /Running/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const transcript = page.getByRole("region", { name: /^Transcript of / });
    await expect(transcript).toBeVisible({ timeout: 60_000 });
    const editor = page.getByRole("textbox", { name: "Message to this worker" });
    await expect(editor).toBeEnabled({ timeout: 60_000 });
    await editor.fill("steer_probe: wrap up now");
    await editor.press("Enter");
    await expect(page.getByText("Finished · read-only")).toBeVisible({ timeout: 180_000 });

    // A collapsed card with a summary: the first one the transcript shows that has text. Its summary is the span
    // that carries the text as its title, so a card whose summary is empty is not measured.
    const summaryOf = () =>
      transcript.locator('[data-slot="u3-tool-card-trigger"] span[title]:not([title=""])').first();
    const summary = summaryOf();
    await expect(summary).toBeVisible({ timeout: 60_000 });
    // The worker's transcript can still replace a row after it first shows, and the box of an element that is being
    // replaced reads as none. The width is read until the card has settled; with the old header it stays a few pixels
    // wide, and the poll runs out.
    await expect
      .poll(async () => (await summaryOf().boundingBox())?.width ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(MIN_SUMMARY_WIDTH);

    await summary.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-1587-summary-light.png"),
      fullPage: true,
    });
    await darkLook(page);
    await page.screenshot({ path: join(screenshots, "fix-1587-summary-dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // The narrow drawer: the panel is shown again, the same worker's transcript, and the same card.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    await hub.getByRole("option", { name: /SteerProbe/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    await expect(transcript).toBeVisible();
    await expect(summaryOf()).toBeVisible({ timeout: 60_000 });
    await summaryOf().scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-1587-summary-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
