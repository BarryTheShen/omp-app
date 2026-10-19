import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Motion (#1173, part 2, #1206): a tool card's content grows and shrinks over the motion duration instead of
 * appearing in one frame. A real-omp chat with three bash calls is opened, the first card is expanded and
 * collapsed, and the page records the card's content height in every frame in which it changes. With the default
 * motion preference the height changes over several frames, and the content declares a height transition of the
 * token duration (--duration-base, 180 ms). With prefers-reduced-motion: reduce it changes in one frame and declares
 * no transition.
 */

declare global {
  interface Window {
    __contentHeight?: HeightSample[];
  }
}

interface HeightSample {
  readonly at: number;
  readonly height: number;
}

interface ToggleResult {
  /** Frames in which the content's height changed during the toggle (-1 means the content was not drawn). */
  readonly frames: number;
  readonly first: number;
  readonly last: number;
}

realTest.use({ seedLongTurn: 3 });

/** Runs in the page before any script: records the first tool card's content height in each frame it changes. */
function recordContentHeight(): void {
  const samples: HeightSample[] = [];
  window.__contentHeight = samples;
  let last = Number.NaN;
  const tick = (): void => {
    const content = document.querySelector('[data-slot="u3-tool-card-content"]');
    const height = content ? Math.round(content.getBoundingClientRect().height * 10) / 10 : -1;
    if (height !== last) {
      last = height;
      samples.push({ at: performance.now(), height });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function openChat(page: Page): Promise<void> {
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.getByText("All 3 steps are done.")).toBeVisible({ timeout: 60_000 });
}

/** Clicks the card, waits for the motion to finish, and reports the content's height changes in that time. */
async function toggle(
  page: Page,
  card: Locator,
  expanded: "true" | "false",
): Promise<ToggleResult> {
  const before = await page.evaluate(() => window.__contentHeight?.length ?? 0);
  await card.click();
  await expect(card).toHaveAttribute("aria-expanded", expanded);
  await waitForFiniteAnimations(page);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 120)));
  return page.evaluate((from): ToggleResult => {
    const moved = (window.__contentHeight ?? []).slice(from).filter((sample) => sample.height >= 0);
    return {
      frames: moved.length,
      first: moved[0]?.height ?? 0,
      last: moved.at(-1)?.height ?? 0,
    };
  }, before);
}

realTest(
  "a tool card's content grows and shrinks over the motion duration",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) => target.addInitScript(recordContentHeight),
    });
    await openChat(page);
    const card = page.locator('[data-slot="u3-tool-card-trigger"]').first();
    const content = page.locator('[data-slot="u3-tool-card-content"]').first();

    const expand = await toggle(page, card, "true");
    const declared = await content.evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(declared.property, "the content animates its height through its grid row").toContain(
      "grid-template-rows",
    );
    expect(declared.duration, "the height transition uses --duration-base").toBe("0.18s");
    expect(
      expand.frames,
      "frames in which the content height changed while expanding",
    ).toBeGreaterThanOrEqual(4);

    const collapse = await toggle(page, card, "false");
    expect(
      collapse.frames,
      "frames in which the content height changed while collapsing",
    ).toBeGreaterThanOrEqual(4);
    console.log(
      `tool card: expand ${expand.frames} frames, ${expand.first} to ${expand.last} px; collapse ${collapse.frames} frames, ${collapse.first} to ${collapse.last} px`,
    );
  },
);

realTest.describe("with reduced motion", () => {
  realTest.use({ seedLongTurn: 3 });
  realTest(
    "the content changes in one frame and declares no transition",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.emulateMedia({ reducedMotion: "reduce" });
          await target.addInitScript(recordContentHeight);
        },
      });
      await openChat(page);
      const card = page.locator('[data-slot="u3-tool-card-trigger"]').first();
      const content = page.locator('[data-slot="u3-tool-card-content"]').first();
      const expand = await toggle(page, card, "true");
      const property = await content.evaluate(
        (element) => getComputedStyle(element).transitionProperty,
      );
      expect(property, "no transition under reduced motion").toBe("none");
      expect(
        expand.frames,
        "frames in which the content height changed while expanding",
      ).toBeLessThanOrEqual(2);
    },
  );
});

realTest(
  "every control in an expanded card keeps its focus ring inside the panel",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await openChat(page);
    const card = page.locator('[data-slot="u3-tool-card-trigger"]').first();
    await card.click();
    await expect(card).toHaveAttribute("aria-expanded", "true");
    await waitForFiniteAnimations(page);
    await card.focus();
    await mkdir(screenshots, { recursive: true });
    const checked: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      const outcome = await page.evaluate((): { name: string; inside: boolean } | null => {
        const active = document.activeElement;
        const panel = document.querySelector('[data-slot="u3-tool-card-content"]');
        if (!(active instanceof HTMLElement) || !panel?.contains(active)) return null;
        const box = active.getBoundingClientRect();
        const frame = panel.getBoundingClientRect();
        const style = getComputedStyle(active);
        const ring = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
        const inside =
          box.left - ring >= frame.left &&
          box.right + ring <= frame.right &&
          box.top - ring >= frame.top &&
          box.bottom + ring <= frame.bottom;
        return {
          name: active.getAttribute("aria-label") ?? active.textContent?.trim() ?? active.tagName,
          inside,
        };
      });
      if (outcome === null) break;
      checked.push(outcome.name);
      expect(outcome.inside, `the focus ring of "${outcome.name}" stays inside the panel`).toBe(
        true,
      );
      if (outcome.name.startsWith("Copy"))
        await page.screenshot({ path: join(screenshots, "motion-tool-card-focus.png") });
    }
    expect(checked.length, "the expanded card has controls to focus").toBeGreaterThan(0);
  },
);

for (const variant of ["light", "dark", "narrow"] as const) {
  realTest(
    `expanded tool card, ${variant}: capture for the pull request`,
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
        await page.getByRole("button", { name: "Show sessions sidebar" }).click();
      }
      await openChat(page);
      if (variant === "narrow") {
        const drawerClose = page.locator('button[aria-label="Close open sidebar"]');
        if ((await drawerClose.count()) > 0) await drawerClose.click();
      }
      const card = page.locator('[data-slot="u3-tool-card-trigger"]').first();
      await card.click();
      await expect(card).toHaveAttribute("aria-expanded", "true");
      await waitForFiniteAnimations(page);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `motion-tool-card-${variant}.png`) });
    },
  );
}
