import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue 2212. A chat picked from the sidebar used to stay on screen until omp had opened the picked chat and its history
 * had loaded: about 6 s when omp takes 4 s to resume. The picked chat's header and opening state now show at the click,
 * the sidebar's rows stay mounted, and a second pick cancels the open before it. The wrapper every chat runs through
 * delays each resumed chat 4 s, as the fix-927 wrapper delays a new chat.
 */
const dir = resolve(process.cwd(), "../../.data/fix-2212-click-feedback");
mkdirSync(dir, { recursive: true });
const delayedResume = join(dir, "omp-resume-delay.sh");
writeFileSync(
  delayedResume,
  `#!/bin/bash
resume=0
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then resume=1; fi
done
if [ "$resume" = 1 ]; then sleep 4; fi
exec "$@"
`,
);
chmodSync(delayedResume, 0o755);
realTest.use({ chatWrapper: delayedResume, idleCloseMs: 500 });
realTest.setTimeout(240_000);

function sidebarRow(page: Page, title: string) {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(`^${title}`) });
}

/**
 * Records, in the page, the order of two changes after a click on the sidebar row for `picked`. `leftAt` is the first
 * change that takes the chat left off the screen while the transcript shows no answer yet: the opening state. `titleShown`
 * says whether the picked row is the selected one then. `answeredAt` is the first change that shows the picked chat's
 * answer. `remounted` counts the rows captured before the click that are no longer in the page at `leftAt`.
 */
async function armFeedbackClock(
  page: Page,
  picked: string,
  leaving: string,
  answer: string,
): Promise<void> {
  await page.evaluate(
    ({ picked, leaving, answer }) => {
      const w = window as unknown as Record<string, unknown>;
      const rows = () => [...document.querySelectorAll('[role="option"]')];
      const transcript = () =>
        document.querySelector('[aria-label="Conversation transcript"]')?.textContent ?? null;
      w.rows = rows();
      document.addEventListener(
        "click",
        (event) => {
          const option = (event.target as Element | null)?.closest?.('[role="option"]');
          if (w.click !== undefined || !option || !(option.textContent ?? "").startsWith(picked))
            return;
          w.click = performance.now();
          const observer = new MutationObserver(() => {
            const shown = transcript();
            if (shown === null) return;
            if (w.leftAt === undefined && !shown.includes(leaving) && !shown.includes(answer)) {
              w.leftAt = performance.now();
              const selected = document.querySelector('[role="option"][aria-selected="true"]');
              w.titleShown = (selected?.textContent ?? "").startsWith(picked);
              w.remounted = (w.rows as Element[]).filter((row) => !row.isConnected).length;
              return;
            }
            if (w.leftAt !== undefined && shown.includes(answer)) {
              w.answeredAt = performance.now();
              observer.disconnect();
            }
          });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        },
        true,
      );
    },
    { picked, leaving, answer },
  );
}

async function clockOf(page: Page): Promise<{
  click: number;
  leftAt: number;
  answeredAt: number;
  remounted: number;
  titleShown: boolean;
}> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      click: (w.click as number | undefined) ?? NaN,
      leftAt: (w.leftAt as number | undefined) ?? NaN,
      answeredAt: (w.answeredAt as number | undefined) ?? NaN,
      remounted: (w.remounted as number | undefined) ?? NaN,
      titleShown: w.titleShown === true,
    };
  });
}

realTest(
  "a chat picked from the sidebar shows at the click, while omp is still starting",
  async ({ realApp }) => {
    const page = await realApp.open();
    const first = await startChat(page);
    await sendPrompt(first, "open probe chat a");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    const second = await startChat(page);
    await sendPrompt(second, "open probe chat b");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await waitForFiniteAnimations(page);
    // A deliberate wait: the chat left (chat a) must have its omp closed by the 500 ms idle close, so the pick below is a
    // resume that takes omp's 4 s start. Nothing else is measured here.
    await page.waitForTimeout(3_000);

    // The chat left must be on screen at the click: the clock measures its leaving, not an empty page.
    await expect(
      page
        .getByRole("region", { name: "Conversation transcript" })
        .getByText("open probe chat b")
        .first(),
    ).toBeVisible();
    await armFeedbackClock(page, "open probe chat a", "open probe chat b", "pong");
    await sidebarRow(page, "open probe chat a").click();
    await expect
      .poll(async () => (await clockOf(page)).answeredAt, { timeout: 60_000 })
      .not.toBeNaN();
    const clock = await clockOf(page);
    // Order, not milliseconds, is asserted: the chat left is gone and the picked row is selected while omp's open is still
    // held by the 4 s wrapper, and the answer comes after that.
    expect(clock.leftAt).not.toBeNaN();
    expect(clock.titleShown).toBe(true);
    expect(clock.leftAt).toBeLessThan(clock.answeredAt);
    expect(clock.remounted).toBe(0);
    await expect(
      page.getByRole("region", { name: "Conversation transcript" }).getByText("open probe chat a"),
    ).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);

// Pictures for the pull request. The chain runs these with CHAIN_ENV="OMP_APP_SHOTS=1"; without it they are skipped.
const screenshots = resolve(process.cwd(), "../../.data/screenshots");
// A resumed chat held for 20 s, so a picked chat is still opening when its picture is taken.
const slowResume = join(dir, "omp-resume-slow.sh");
writeFileSync(
  slowResume,
  `#!/bin/bash
resume=0
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then resume=1; fi
done
if [ "$resume" = 1 ]; then sleep 20; fi
exec "$@"
`,
);
chmodSync(slowResume, 0o755);

/** Two answered chats, the second one open: chat a has been left, so its omp has closed when it is picked. */
async function answeredChatsThenLeave(page: Page): Promise<void> {
  const transcript = page.getByRole("region", { name: "Conversation transcript" });
  const first = await startChat(page);
  await sendPrompt(first, "open probe chat a");
  await expect(transcript.getByText("pong", { exact: true }).first()).toBeVisible({
    timeout: 90_000,
  });
  const second = await startChat(page);
  await sendPrompt(second, "open probe chat b");
  await expect(transcript.getByText("open probe chat b").first()).toBeVisible({ timeout: 90_000 });
  await expect(transcript.getByText("pong", { exact: true }).first()).toBeVisible({
    timeout: 90_000,
  });
  await waitForFiniteAnimations(page);
  // A deliberate wait on real omp: the 500 ms idle close stops chat a's omp, so the pick is a resume held for 20 s.
  await page.waitForTimeout(3_000);
}

/** The page's background once the theme's tokens have loaded: near white in light, near black in dark. */
async function expectTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  const rgb = await page.evaluate(() => {
    // The conversation's own background: the app root and body paint nothing, so their backgrounds are transparent.
    let element: Element | null = document.querySelector("main");
    while (element && getComputedStyle(element).backgroundColor === "rgba(0, 0, 0, 0)") {
      element = element.parentElement;
    }
    // Nothing painted means the canvas shows, and the canvas is white.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return [255, 255, 255];
    context.fillStyle = element ? getComputedStyle(element).backgroundColor : "#ffffff";
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
    return [red, green, blue];
  });
  const mean = rgb.reduce((sum, value) => sum + value, 0) / rgb.length;
  if (theme === "dark") expect(mean).toBeLessThan(60);
  else expect(mean).toBeGreaterThan(200);
}

/** The picture of a chat still opening: the composer says so, the theme has loaded, and then the answer arrives. */
async function pictureWhileOpening(
  page: Page,
  theme: "light" | "dark",
  file: string,
): Promise<void> {
  await expect(page.getByText(/^Opening session/).first()).toBeVisible({ timeout: 10_000 });
  await expectTheme(page, theme);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, file), fullPage: true });
  await expect(
    page
      .getByRole("region", { name: "Conversation transcript" })
      .getByText("pong", { exact: true })
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

realTest.describe("the picked chat while omp is still opening it", () => {
  realTest.use({ chatWrapper: slowResume });

  realTest("a picked chat shows at the click, in light", async ({ realApp }, testInfo) => {
    realTest.skip(
      process.env.OMP_APP_SHOTS === undefined,
      "screenshots run only with OMP_APP_SHOTS=1",
    );
    testInfo.setTimeout(400_000);
    mkdirSync(screenshots, { recursive: true });
    const page = await realApp.open();
    await answeredChatsThenLeave(page);
    await sidebarRow(page, "open probe chat a").click();
    await expect(page.locator('[data-slot="r1-session-row"][data-selected="true"]')).toContainText(
      "open probe chat a",
    );
    await pictureWhileOpening(page, "light", "fix-2212-light.png");
  });

  realTest("a picked chat shows at the click, in dark", async ({ realApp }, testInfo) => {
    realTest.skip(
      process.env.OMP_APP_SHOTS === undefined,
      "screenshots run only with OMP_APP_SHOTS=1",
    );
    testInfo.setTimeout(400_000);
    mkdirSync(screenshots, { recursive: true });
    const page = await realApp.open();
    // The theme is set before any chat exists, as the context-panel spec sets it: a reload while a chat is opening
    // would restore that chat and leave the next New chat waiting on it.
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await answeredChatsThenLeave(page);
    await sidebarRow(page, "open probe chat a").click();
    await expect(page.locator('[data-slot="r1-session-row"][data-selected="true"]')).toContainText(
      "open probe chat a",
    );
    await pictureWhileOpening(page, "dark", "fix-2212-dark.png");
  });

  realTest("a picked chat shows at the click, at 390 px", async ({ realApp }, testInfo) => {
    realTest.skip(
      process.env.OMP_APP_SHOTS === undefined,
      "screenshots run only with OMP_APP_SHOTS=1",
    );
    testInfo.setTimeout(400_000);
    mkdirSync(screenshots, { recursive: true });
    const page = await realApp.open();
    await answeredChatsThenLeave(page);
    // At 390 px the sessions sidebar sits behind its button, and the pick comes from that drawer.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await sidebarRow(page, "open probe chat a").click();
    await pictureWhileOpening(page, "light", "fix-2212-390.png");
  });
});
