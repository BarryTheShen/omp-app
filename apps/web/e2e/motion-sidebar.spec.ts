import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Motion (#1173, part 4, #1208): the sessions sidebar slides in and out over the motion duration instead of the
 * transcript jumping in one frame. The page samples the transcript column's width in every frame and records the
 * long tasks (over 50 ms) the toggle causes, on a long real-omp chat. With the default motion preference the column
 * takes several frames to reach its new width, and the sidebar declares a width transition of the token duration
 * (--duration-base, 180 ms). With prefers-reduced-motion: reduce it reaches the new width in one frame.
 */

declare global {
  interface Window {
    __shell?: { samples: { at: number; width: number }[]; longTasks: number[] };
  }
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 10, 9, 0, 0);
const minute = 60_000;
const answer = [
  "Keep the parser stable by checking the grammar tests first.",
  "",
  "- Pin the **token** table before a refactor.",
  "- Run `bun test` before every merge.",
  "",
  "```ts",
  "const stable = parse(input, { strict: true });",
  "```",
].join("\n");

// A long chat: 40 exchanges of markdown answers, so the toggle reflows real content.
const entries = Array.from({ length: 40 }, (_, index) => [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `Question ${index + 1}: how do I keep the parser stable?` }],
      timestamp: at + index * 2 * minute,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Answer ${index + 1}.\n\n${answer}` }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: at + (index * 2 + 1) * minute,
    },
  },
]).flat();

realTest.use({ seedEntries: { entries } });

/** Runs in the page before any script: records the transcript column's width in each frame it changes, and the long tasks. */
function recordShell(): void {
  const samples: { at: number; width: number }[] = [];
  const longTasks: number[] = [];
  window.__shell = { samples, longTasks };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  let last = Number.NaN;
  const tick = (): void => {
    const main = document.querySelector('[data-shell-main="true"]');
    const width = main ? Math.round(main.getBoundingClientRect().width * 10) / 10 : -1;
    if (width !== last) {
      last = width;
      samples.push({ at: performance.now(), width });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

interface ToggleResult {
  /** Frames in which the transcript column changed width during the toggle. */
  readonly frames: number;
  /** Long tasks (over 50 ms) that ran during the toggle, longest first. */
  readonly longTasks: readonly number[];
}

/** Clicks a control, waits for the motion to finish, and reports the column's frames and the long tasks in that time. */
async function toggle(page: Page, click: () => Promise<void>): Promise<ToggleResult> {
  const from = await page.evaluate(() => {
    const shell = window.__shell;
    return { samples: shell?.samples.length ?? 0, tasks: shell?.longTasks.length ?? 0 };
  });
  await click();
  await waitForFiniteAnimations(page);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 120)));
  return page.evaluate((start): ToggleResult => {
    const shell = window.__shell;
    const frames = (shell?.samples ?? [])
      .slice(start.samples)
      .filter((sample) => sample.width >= 0);
    const tasks = (shell?.longTasks ?? []).slice(start.tasks).sort((a, b) => b - a);
    return { frames: frames.length, longTasks: tasks.map((task) => Math.round(task)) };
  }, from);
}

async function openChat(page: Page): Promise<void> {
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.getByText("Answer 40.")).toBeVisible({ timeout: 60_000 });
}

realTest(
  "the sessions sidebar slides over the motion duration, without a long jump of the transcript",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({ beforeLoad: (target) => target.addInitScript(recordShell) });
    await openChat(page);
    const sidebar = page.locator('[data-shell-sidebar="left"]');
    const declared = await sidebar.evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(declared.property, "the sidebar animates its width").toContain("width");
    expect(declared.duration, "the sidebar uses --duration-base").toBe("0.18s");

    const hide = await toggle(page, () =>
      page.locator('button[aria-label="Hide sessions sidebar"]').click(),
    );
    await expect(sidebar).toHaveAttribute("data-open", "false");
    const show = await toggle(page, () =>
      page.locator('button[aria-label="Show sessions sidebar"]').click(),
    );
    await expect(sidebar).toHaveAttribute("data-open", "true");
    expect(
      hide.frames,
      "frames in which the transcript column changed width while the sidebar hides",
    ).toBeGreaterThanOrEqual(4);
    expect(
      show.frames,
      "frames in which the transcript column changed width while the sidebar shows",
    ).toBeGreaterThanOrEqual(4);
    console.log(
      `sidebar: hide ${hide.frames} frames, long tasks ${JSON.stringify(hide.longTasks)} ms; show ${show.frames} frames, long tasks ${JSON.stringify(show.longTasks)} ms`,
    );
  },
);

realTest.describe("with reduced motion", () => {
  realTest.use({ seedEntries: { entries } });
  realTest("the transcript reaches its new width in one frame", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.emulateMedia({ reducedMotion: "reduce" });
        await target.addInitScript(recordShell);
      },
    });
    await openChat(page);
    const sidebar = page.locator('[data-shell-sidebar="left"]');
    const property = await sidebar.evaluate(
      (element) => getComputedStyle(element).transitionProperty,
    );
    expect(property, "no transition under reduced motion").toBe("none");
    const hide = await toggle(page, () =>
      page.locator('button[aria-label="Hide sessions sidebar"]').click(),
    );
    expect(hide.frames, "frames in which the transcript column changed width").toBeLessThanOrEqual(
      2,
    );
  });
});

for (const variant of ["light", "dark", "narrow"] as const) {
  realTest(
    `sessions sidebar hidden, ${variant}: capture for the pull request`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({
        beforeLoad: async (target) => {
          if (variant === "dark")
            await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
        },
      });
      if (variant === "narrow") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('button[aria-label="Show sessions sidebar"]').click();
        await openChat(page);
        const drawerClose = page.locator('button[aria-label="Close open sidebar"]');
        if ((await drawerClose.count()) > 0) await drawerClose.click();
      } else {
        await openChat(page);
        await page.locator('button[aria-label="Hide sessions sidebar"]').click();
      }
      await waitForFiniteAnimations(page);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `motion-sidebar-${variant}.png`) });
    },
  );
}
