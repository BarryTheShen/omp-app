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

/*
 * Issue 1330: with thinking hidden (Alt+T), the reasoning of a streaming reply was still drawn in full, and the
 * "Thinking" pulse that stands in for it never showed. The fake model's `stream_reasoning` keyword streams about
 * fourteen seconds of reasoning, then its answer. While the reasoning streams, the transcript shows the one pulse and
 * none of the reasoning text; once the answer starts, nothing of the reasoning is left. Captured in light, dark and
 * at 390 px.
 */

const MARKER = "reasoning-marker-7f3a";
const ANSWER = "The answer after the reasoning.";

/** Lets finite transitions settle before a measurement or a screenshot. Bounded, so a stuck transition cannot hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

realTest(
  "#1330: with thinking hidden, a streaming reply shows the one Thinking pulse and none of its reasoning",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);

    // Alt+T is a transcript chord, and the composer holds focus after a chat opens: click the transcript first.
    await page.getByRole("region", { name: "Conversation transcript" }).click();
    await expect(composer).not.toBeFocused();
    await page.keyboard.press("Alt+t");
    // The choice is stored per chat as "true" (visible) or "false" (hidden).
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.localStorage)
            .filter((key) => key.startsWith("omp.u1.thinking.visibility."))
            .map((key) => window.localStorage.getItem(key)),
        ),
      )
      .toContain("false");

    await sendPrompt(composer, "Please stream_reasoning and answer.");

    // While the reasoning streams: the one pulse shows, and none of the reasoning text is drawn.
    const pulse = page.getByRole("status", { name: "Thinking" });
    await expect(pulse, "the Thinking pulse shows while the reasoning streams").toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText(MARKER), "no reasoning text is drawn while it streams").toHaveCount(
      0,
    );
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1330-light.png") });

    await setTheme(page, true);
    await expect(pulse).toBeVisible();
    await expect(page.getByText(MARKER)).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "fix-1330-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(pulse).toBeVisible();
    await expect(page.getByText(MARKER)).toHaveCount(0);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1330-390.png") });

    // When the answer starts, the reasoning group is gone: no pulse, no reasoning text, no "Thought" line.
    await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 60_000 });
    await expect(pulse).toHaveCount(0);
    await expect(page.getByText(MARKER)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Thought/ })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
