import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * The Settings dialog keeps its box while its content loads (#2584). The settings are read after the dialog opens. The
 * test holds those reads for 1.5 s after the click, so the dialog is on screen with its loading state, then releases
 * them. From the first frame the dialog is on screen until 500 ms after its content shows, the layout top, left and
 * height must each stay within 2 px. The layout box is read, not the drawn box: the enter animation scales the drawn box.
 * The content shows at the first change inside the dialog after the release, a DOM change or a change in its layout.
 */

interface StableFrame {
  readonly present: boolean;
  /** The layout box's top edge: its center minus half its layout height. */
  readonly top: number;
  /** The layout box's left edge: its center minus half its layout width. */
  readonly left: number;
  readonly height: number;
}

declare global {
  interface Window {
    __stableFrames?: StableFrame[];
    __stableRecording?: boolean;
    __stableReleasedAt?: number | null;
    __stableContentAt?: number | null;
  }
}

/**
 * Runs in the page before the click. Records the dialog on every animation frame until 500 ms after its content shows
 * (and at least 1 s after the release).
 */
function startStableRecording(): void {
  const frames: StableFrame[] = [];
  const started = performance.now();
  window.__stableFrames = frames;
  window.__stableRecording = true;
  window.__stableReleasedAt = null;
  window.__stableContentAt = null;
  const markContent = (at: number): void => {
    if (window.__stableReleasedAt === null || window.__stableReleasedAt === undefined) return;
    if (window.__stableContentAt === null || window.__stableContentAt === undefined) {
      window.__stableContentAt = at;
    }
  };
  const observer = new MutationObserver((records) => {
    const popup = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]');
    if (popup !== null && records.some((record) => popup.contains(record.target))) {
      markContent(performance.now());
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  const sample = (): void => {
    const popup = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]');
    if (popup === null) {
      frames.push({ present: false, top: 0, left: 0, height: 0 });
      return;
    }
    const box = popup.getBoundingClientRect();
    const style = getComputedStyle(popup);
    const height = Number.parseFloat(style.height);
    const width = Number.parseFloat(style.width);
    const frame: StableFrame = {
      present: true,
      top: box.top + box.height / 2 - height / 2,
      left: box.left + box.width / 2 - width / 2,
      height,
    };
    frames.push(frame);
    const first = frames.find((candidate) => candidate.present);
    if (
      first !== undefined &&
      (Math.abs(frame.height - first.height) > 0.5 || Math.abs(frame.top - first.top) > 0.5)
    ) {
      markContent(performance.now());
    }
  };
  const tick = (): void => {
    if (!window.__stableRecording) return;
    sample();
    const releasedAt = window.__stableReleasedAt ?? null;
    const contentAt = window.__stableContentAt ?? null;
    const now = performance.now();
    const finished =
      (releasedAt !== null &&
        now >= Math.max(releasedAt + 1000, (contentAt ?? releasedAt) + 500)) ||
      now - started > 8000;
    if (finished) {
      window.__stableRecording = false;
      observer.disconnect();
      return;
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

/**
 * Holds the settings reads (the config store's `read` and `list` calls) while `hold` is in effect, so the dialog keeps
 * its loading state until `release`. Every other message passes through.
 */
function settingsReadHold(): {
  readonly install: (page: Page) => Promise<void>;
  readonly hold: () => void;
  readonly release: () => void;
} {
  let holding = false;
  const pending: Array<() => void> = [];
  return {
    install: async (page) => {
      await page.routeWebSocket(/\/ws/, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message)) as {
            readonly type?: unknown;
            readonly port?: unknown;
            readonly method?: unknown;
          };
          const settingsRead =
            frame.type === "call" &&
            frame.port === "A1.configStore" &&
            (frame.method === "read" || frame.method === "list");
          if (holding && settingsRead) pending.push(() => server.send(message));
          else server.send(message);
        });
        server.onMessage((message) => socket.send(message));
      });
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const send of pending.splice(0)) send();
    },
  };
}

const cases = [
  { name: "light-1280x900", theme: "light", width: 1280, height: 900 },
  { name: "dark-1280x900", theme: "dark", width: 1280, height: 900 },
  { name: "light-390x844", theme: "light", width: 390, height: 844 },
] as const;

for (const variant of cases) {
  realTest(
    `Settings keeps its box while its content loads, ${variant.name}`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const reads = settingsReadHold();
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await reads.install(target);
          await target.addInitScript(
            (theme: string) => window.localStorage.setItem("omp-app.theme", theme),
            variant.theme,
          );
        },
      });
      await page.setViewportSize({ width: variant.width, height: variant.height });
      await waitForFiniteAnimations(page);

      await page.evaluate(startStableRecording);
      reads.hold();
      await page.getByRole("button", { name: "Settings", exact: true }).first().click();
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        window.__stableReleasedAt = performance.now();
      });
      reads.release();
      await page.waitForFunction(() => window.__stableRecording === false, undefined, {
        timeout: 30_000,
      });
      const frames = await page.evaluate(() => window.__stableFrames ?? []);
      const contentAt = await page.evaluate(() => window.__stableContentAt ?? null);
      const shown = frames.filter((frame) => frame.present);
      const firstFrame = shown[0];

      expect(contentAt, "the content shows after the held reads arrive").not.toBeNull();
      expect(shown.length, "frames with the Settings dialog on screen").toBeGreaterThan(5);
      const spread = (pick: (frame: StableFrame) => number): number =>
        firstFrame === undefined
          ? Number.NaN
          : Math.max(...shown.map((frame) => Math.abs(pick(frame) - pick(firstFrame))));
      expect(
        spread((frame) => frame.top),
        "the dialog's top edge does not move",
      ).toBeLessThanOrEqual(2);
      expect(
        spread((frame) => frame.left),
        "the dialog's left edge does not move",
      ).toBeLessThanOrEqual(2);
      expect(
        spread((frame) => frame.height),
        "the dialog's height does not change",
      ).toBeLessThanOrEqual(2);

      await waitForFiniteAnimations(page);
      await page.screenshot({ path: join(screenshots, `fix-2584-settings-${variant.name}.png`) });
    },
  );
}
