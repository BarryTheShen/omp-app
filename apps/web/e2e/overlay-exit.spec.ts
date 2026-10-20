import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const BACKDROP = '[data-slot="dialog-overlay"]';
const CYCLES = 5;

type ExitSample = {
  readonly surface: string;
  readonly cycle: number;
  readonly closed: readonly { kind: string; fillMode: string }[];
  readonly snapBack: boolean;
  readonly frames: readonly { at: number; opacity: number }[];
};

function seededEntries(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    type: "message",
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Exit audit message ${index + 1}` }],
      ...(index % 2 === 1
        ? {
            api: "openai-completions",
            provider: "fake",
            model: "fake-model",
            stopReason: "stop",
          }
        : {}),
      timestamp: Date.UTC(2026, 9, 3) + index * 1000,
    },
  }));
}

function installExitRecorder(): void {
  const backdropSelector = '[data-slot="dialog-overlay"]';
  const popupSelector = '[role="dialog"][data-overlay-id]';
  const state = {
    closing: false,
    closeAt: 0,
    closed: [] as Array<{ kind: string; fillMode: string }>,
    frames: [] as Array<{ at: number; opacity: number }>,
  };
  const opacity = (): number => {
    const element = document.querySelector<HTMLElement>(backdropSelector);
    return element === null ? -1 : Number(getComputedStyle(element).opacity);
  };
  const sample = (time: number): void => {
    if (state.closing) state.frames.push({ at: time - state.closeAt, opacity: opacity() });
    requestAnimationFrame(sample);
  };
  const observer = new MutationObserver((records) => {
    if (!state.closing) return;
    for (const record of records) {
      if (!(record.target instanceof HTMLElement) || !record.target.hasAttribute("data-closed"))
        continue;
      const kind = record.target.matches(backdropSelector)
        ? "backdrop"
        : record.target.matches(popupSelector)
          ? "popup"
          : "other";
      if (kind === "other" || state.closed.some((entry) => entry.kind === kind)) continue;
      state.closed.push({ kind, fillMode: getComputedStyle(record.target).animationFillMode });
    }
  });
  observer.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-closed"] });
  requestAnimationFrame(sample);
  (window as unknown as { __overlayExit?: unknown }).__overlayExit = {
    beforeClose: () => {
      state.closing = true;
      state.closeAt = performance.now();
      state.closed = [];
      state.frames = [];
    },
    stop: () => {
      state.closing = false;
      let belowHalf = false;
      let minimum = 1;
      let snapBack = false;
      for (const frame of state.frames) {
        if (frame.opacity < 0) continue;
        if (frame.opacity < 0.5) {
          belowHalf = true;
          minimum = Math.min(minimum, frame.opacity);
        } else if (belowHalf && frame.opacity - minimum >= 0.2) {
          snapBack = true;
        }
      }
      return { closed: state.closed, frames: state.frames, snapBack };
    },
  };
}

async function prepareChat(page: Page): Promise<void> {
  const rows = page.locator('[data-slot="u1-message-row"]');
  if ((await rows.count()) === 0) {
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  }
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await waitForFiniteAnimations(page);
}

async function beginClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const recorder = (window as unknown as { __overlayExit: { beforeClose: () => void } })
      .__overlayExit;
    recorder.beforeClose();
  });
}

async function readExit(page: Page, surface: string, cycle: number): Promise<ExitSample> {
  const sample = await page.evaluate(() => {
    const recorder = (
      window as unknown as { __overlayExit: { stop: () => Omit<ExitSample, "surface" | "cycle"> } }
    ).__overlayExit;
    return recorder.stop();
  });
  console.log(
    `${surface} cycle ${cycle} backdrop opacity: ${sample.frames.map((frame) => frame.opacity.toFixed(2)).join(" ")}`,
  );
  return { surface, cycle, ...sample };
}

async function openSurface(page: Page, surface: "settings" | "palette" | "model"): Promise<void> {
  if (surface === "settings") {
    await page.getByRole("button", { name: "Settings" }).first().click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    return;
  }
  if (surface === "palette") {
    await page.getByRole("textbox", { name: "Message input" }).focus();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    return;
  }
  await page.getByRole("button", { name: /^(Choose a model|Model:)/ }).click();
  await expect(page.getByRole("dialog", { name: "Model and thinking" })).toBeVisible();
}

async function closeFromBackdrop(page: Page): Promise<void> {
  await beginClose(page);
  await page.mouse.click(4, 4);
  await expect(page.locator(BACKDROP)).toHaveCount(0, { timeout: 20_000 });
}

realTest.use({ seedEntries: { entries: seededEntries(50) } });

realTest(
  "modal exits keep the backdrop transparent after data-closed",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open({
      beforeLoad: (target) => target.addInitScript(installExitRecorder),
    });
    await prepareChat(page);
    const samples: ExitSample[] = [];
    for (const surface of ["settings", "palette", "model"] as const) {
      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        await openSurface(page, surface);
        await waitForFiniteAnimations(page);
        await closeFromBackdrop(page);
        samples.push(await readExit(page, surface, cycle));
      }
    }
    for (const sample of samples) {
      expect(
        sample.closed.map((entry) => entry.kind),
        `${sample.surface} cycle ${sample.cycle}`,
      ).toEqual(expect.arrayContaining(["backdrop", "popup"]));
      expect(
        sample.closed.every((entry) => entry.fillMode === "forwards"),
        `${sample.surface} cycle ${sample.cycle}`,
      ).toBe(true);
      expect(sample.snapBack, `${sample.surface} cycle ${sample.cycle}`).toBe(false);
    }
    await openSurface(page, "settings");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "overlay-exit-light.png"), fullPage: true });
    await page.locator("html").evaluate((element) => element.classList.add("dark"));
    await page.screenshot({ path: join(screenshots, "overlay-exit-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, "overlay-exit-390.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
