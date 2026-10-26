import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ROOT,
  expect,
  realTest,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

type Timeline = readonly [time: number, top: number, loading: boolean, empty: boolean][];
const EXTENSION_FILE = "fix-2153-notices.ts";
const EXTENSION_SOURCE = `export default function notices(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("notice one", "info");
    ctx.ui.notify("notice two", "info");
    ctx.ui.notify("notice three", "info");
  });
}
`;
const DATA_DIR = join(APP_ROOT, ".data");
const OMP_WITH_NOTICES = join(DATA_DIR, "fix-2153-omp-with-notices.sh");
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
  OMP_WITH_NOTICES,
  `#!/bin/sh\nexec "$@" --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}"\n`,
);
chmodSync(OMP_WITH_NOTICES, 0o755);
realTest.use({
  chatWrapper: OMP_WITH_NOTICES,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});

function recordComposerTimeline(): void {
  const timeline: Array<[number, number, boolean, boolean]> = [];
  Reflect.set(window, "__composerTimeline", timeline);
  const started = performance.now();
  let last = "";
  const sample = (): void => {
    const composer = document.querySelector<HTMLElement>('[data-shell-region="composer"]');
    if (composer !== null) {
      const loading = document.querySelector('[data-slot="u1-thread-loading"]') !== null;
      const empty = document.querySelector('[data-empty-chat="true"]') !== null;
      const top = Math.round(composer.getBoundingClientRect().top);
      const key = `${top}|${loading}|${empty}`;
      if (key !== last) {
        timeline.push([Math.round(performance.now() - started), top, loading, empty]);
        last = key;
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
realTest("open empty-chat notices never cover the greeting or composer", async ({ realApp }) => {
  for (const theme of ["light", "dark"] as const) {
    for (const viewport of [
      { name: "desktop", width: 1280, height: 800 },
      { name: "wide-phone", width: 768, height: 844 },
      { name: "phone", width: 390, height: 844 },
    ] as const) {
      const page = await realApp.open({
        beforeLoad: async (target) => {
          await target.addInitScript((value) => {
            window.localStorage.setItem("omp-app.theme", value);
          }, theme);
        },
      });
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        if (viewport.width <= 768) {
          await page.getByRole("button", { name: "Show sessions sidebar" }).click();
        }
        await startChat(page);
        const drawerClose = page.locator('button[aria-label="Close open sidebar"]');
        if ((await drawerClose.count()) > 0) await drawerClose.click();
        const toggle = page.getByRole("button", { name: "3 notices from omp" });
        await expect(toggle).toBeVisible({ timeout: 60_000 });
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await waitForFiniteAnimations(page);
        const result = await page.evaluate(() => {
          const notices = document.querySelector<HTMLElement>('[data-testid="n1-notices"]');
          const greeting = document.querySelector<HTMLElement>('[data-empty-chat="true"]');
          const composerCard = document.querySelector<HTMLElement>("[data-composer-card]");
          if (notices === null || greeting === null || composerCard === null) {
            throw new Error("The notice hit-test surfaces are missing");
          }
          const targets = [greeting, composerCard];
          let sampled = 0;
          let covered = 0;
          for (const target of targets) {
            const rect = target.getBoundingClientRect();
            for (let row = 0; row < 5; row += 1) {
              for (let column = 0; column < 5; column += 1) {
                const x = rect.left + ((column + 0.5) / 5) * rect.width;
                const y = rect.top + ((row + 0.5) / 5) * rect.height;
                sampled += 1;
                const hit = document.elementFromPoint(x, y);
                if (hit !== null && notices.contains(hit)) covered += 1;
              }
            }
          }
          return { covered, sampled };
        });
        console.log(`NOTICE_HIT_TEST ${theme}-${viewport.name} ${JSON.stringify(result)}`);
        expect(result.sampled).toBe(50);
        expect(result.covered).toBe(0);
      } finally {
        await page.close();
      }
    }
  }
});

realTest.describe("#2153 loading layout", () => {
  realTest("a new chat is centered from its first empty-chat frame", async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) => target.addInitScript(recordComposerTimeline),
    });
    await startChat(page);
    await expect(page.locator('[data-empty-chat="true"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-shell-main="true"][data-new-chat="true"]')).toBeAttached();
    await waitForFiniteAnimations(page);
    const timeline = await page.evaluate(
      () => Reflect.get(window, "__composerTimeline") as Timeline,
    );
    const emptyTops = timeline.filter(([, , , empty]) => empty).map(([, top]) => top);
    console.log(`NEW_CHAT_COMPOSER_TIMELINE ${JSON.stringify(timeline)}`);
    expect(emptyTops.length).toBeGreaterThan(0);
    expect(new Set(emptyTops).size).toBe(1);
  });

  realTest("an existing chat stays docked while its history loads", async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "ping seed");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.addInitScript(recordComposerTimeline);
    await page.reload();
    await expect(page.locator('[data-shell-main="true"][data-new-chat="true"]')).toHaveCount(0);
    await expect(page.locator('[data-shell-region="composer"]')).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    const timeline = await page.evaluate(
      () => Reflect.get(window, "__composerTimeline") as Timeline,
    );
    const loadingStart = timeline.findIndex(([, , loading]) => loading);
    const existingTops = timeline
      .slice(loadingStart < 0 ? 0 : loadingStart)
      .filter(([, , , empty]) => !empty)
      .map(([, top]) => top);
    console.log(`EXISTING_CHAT_COMPOSER_TIMELINE ${JSON.stringify(timeline)}`);
    expect(existingTops.length).toBeGreaterThan(0);
    expect(new Set(existingTops).size).toBe(1);
  });
});
