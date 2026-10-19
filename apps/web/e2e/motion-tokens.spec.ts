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
 * Motion (#1173, part 6, issue 1210): every transition and animation takes its timing from the motion tokens, and
 * prefers-reduced-motion turns them off. The reasoning block's trigger declares the fast token; its chevron declares
 * the base token and turns when the block opens. Under reduced motion every transition declares the zero token
 * (0.01 ms), and the audit flow (the command palette, the sessions sidebar, a reasoning block) starts no animation
 * that lasts longer than a millisecond.
 */

declare global {
  interface Window {
    __turns?: { seen: Set<string>; running: boolean };
  }
}

/** The zero token is 0.01 ms: a transition that short is no motion. */
const ZERO_SECONDS = 0.00001;
const PALETTE = '[role="dialog"][aria-label="Command palette"]';
const TRIGGER = "[data-u1-reasoning-trigger]";
const CHEVRON = `${TRIGGER} span.transition-transform`;

/** Runs in the page: the longest transition the element declares, in seconds. */
function longestTransition(element: Element): number {
  return Math.max(
    ...getComputedStyle(element)
      .transitionDuration.split(",")
      .map((value) => Number.parseFloat(value)),
  );
}

/** Runs in the page: the chevron's rotation as computed now (Tailwind's rotate-90 sets the rotate property). */
function rotationOf(element: Element): string {
  return getComputedStyle(element).getPropertyValue("rotate");
}

/**
 * Runs in the page: counts the animations running now that last longer than a millisecond, on the elements inside
 * `scope` (every element when `scope` is empty). An animation that never ends counts as moving.
 */
function movingIn(scope: string): number {
  return document.getAnimations().filter((animation) => {
    if (animation.playState !== "running") return false;
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    if (scope !== "" && (target === null || target.closest(scope) === null)) return false;
    const duration = Number(animation.effect?.getComputedTiming().duration);
    return Number.isNaN(duration) || duration > 1;
  }).length;
}

/**
 * Starts recording the chevron's rotation in every frame, before the click it is to record. The returned function
 * stops the recording and reports how many distinct rotations it saw.
 */
async function recordTurns(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((selector) => {
    const state = { seen: new Set<string>(), running: true };
    window.__turns = state;
    const tick = (): void => {
      if (!state.running) return;
      const chevron = document.querySelector(selector);
      if (chevron) state.seen.add(getComputedStyle(chevron).getPropertyValue("rotate"));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, CHEVRON);
  return () =>
    page.evaluate(() => {
      const state = window.__turns;
      if (state === undefined) return 0;
      state.running = false;
      return state.seen.size;
    });
}

/** Opens a chat whose reply has a reasoning block, and waits until the block's trigger is drawn. */
async function chatWithReasoning(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, "pong");
  await expect(page.locator(TRIGGER).first()).toBeVisible({ timeout: 60_000 });
  await waitForFiniteAnimations(page);
}

realTest(
  "transitions take the motion tokens, and the reasoning chevron turns when its block opens",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await chatWithReasoning(page);
    const trigger = page.locator(TRIGGER).first();
    const chevron = page.locator(CHEVRON).first();

    expect(
      await trigger.evaluate(longestTransition),
      "the trigger's transition takes the fast token",
    ).toBeCloseTo(0.12, 3);
    expect(
      await chevron.evaluate(longestTransition),
      "the chevron's transition takes the base token",
    ).toBeCloseTo(0.18, 3);

    await page.keyboard.press("Control+k");
    await expect(page.locator(PALETTE)).toBeVisible();
    expect(
      await page.evaluate(movingIn, PALETTE),
      "the palette's entrance moves under default motion",
    ).toBeGreaterThanOrEqual(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(PALETTE)).toHaveCount(0);

    const from = await chevron.evaluate(rotationOf);
    const to = from === "none" ? "90deg" : "none";
    const stop = await recordTurns(page);
    await trigger.click();
    await expect.poll(() => chevron.evaluate(rotationOf)).toBe(to);
    expect(await stop(), "distinct chevron rotations while the block opens").toBeGreaterThanOrEqual(
      3,
    );

    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "motion-tokens-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "motion-tokens-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "motion-tokens-390.png") });
  },
);

realTest(
  "with reduced motion every transition declares the zero token, and the audit flow starts no moving animation",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ reducedMotion: "reduce" }),
    });
    await chatWithReasoning(page);
    const trigger = page.locator(TRIGGER).first();
    const chevron = page.locator(CHEVRON).first();

    expect(
      await trigger.evaluate(longestTransition),
      "the trigger's transition is the zero token",
    ).toBeLessThanOrEqual(ZERO_SECONDS);
    expect(
      await chevron.evaluate(longestTransition),
      "the chevron's transition is the zero token",
    ).toBeLessThanOrEqual(ZERO_SECONDS);

    await page.keyboard.press("Control+k");
    await expect(page.locator(PALETTE)).toBeVisible();
    expect(await page.evaluate(movingIn, ""), "the palette's entrance under reduced motion").toBe(
      0,
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(PALETTE)).toHaveCount(0);

    await page.getByRole("button", { name: "Hide sessions sidebar" }).click();
    expect(await page.evaluate(movingIn, ""), "the sidebar's hide under reduced motion").toBe(0);
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    expect(await page.evaluate(movingIn, ""), "the sidebar's show under reduced motion").toBe(0);

    const from = await chevron.evaluate(rotationOf);
    const to = from === "none" ? "90deg" : "none";
    const stop = await recordTurns(page);
    await trigger.click();
    await expect.poll(() => chevron.evaluate(rotationOf)).toBe(to);
    expect(await stop(), "distinct chevron rotations under reduced motion").toBeLessThanOrEqual(2);
    expect(
      await page.evaluate(movingIn, ""),
      "the reasoning block's change under reduced motion",
    ).toBe(0);

    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "motion-tokens-reduced.png") });
  },
);
