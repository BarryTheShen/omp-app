/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

const HEADING = "The conversation could not continue.";
const FIRST_STOP = "omp exited (signal SIGKILL)";
const RESTART_STOP = "omp stopped while it was starting. Try again.";

function banner(page: Page): Locator {
  return page.locator('[data-slot="u1-thread-error"]');
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/** The omp the app's server starts after the ones in `before`: the restarted process, as soon as it is listed. */
async function freshOmpPid(realApp: RealApp, before: readonly number[]): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const fresh = realApp.ompProcesses().find((pid) => !before.includes(pid));
    if (fresh !== undefined) return fresh;
    await sleep(10);
  }
  throw new Error("the restarted omp was never listed");
}

/**
 * Issue #980 and the text half of #1716. omp is killed, then restarted, and the restarted omp is killed the moment it is
 * listed, before it reports ready. The banner's detail line shows the server's reason for the first stop, and after the
 * failed restart the sentence that says omp stopped while it was starting. The spec asserts those lines exactly, with no
 * internal word, and Restart omp stays. Captured in light, dark and at 390 px.
 */
realTest(
  "real omp: an omp killed again while it is starting says so in plain words",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "hello");
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });

    const first = realApp.ompProcesses();
    expect(first).toHaveLength(1);
    for (const pid of first) process.kill(pid, "SIGKILL");

    const restart = banner(page).getByRole("button", { name: "Restart omp" });
    const lines = banner(page).locator("p");
    await expect(lines).toHaveText([HEADING, FIRST_STOP], { timeout: 30_000 });
    await expect(restart).toBeVisible();

    await restart.click();
    process.kill(await freshOmpPid(realApp, first), "SIGKILL");

    await expect(lines).toHaveText([HEADING, RESTART_STOP], { timeout: 60_000 });
    await expect(banner(page)).not.toContainText(/RPC|transport/i);
    await expect(restart).toBeVisible();
    await expect(banner(page)).toBeInViewport();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-980-stopped-starting-light.png") });

    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-980-stopped-starting-dark.png") });
    await setTheme(page, false);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(restart).toBeInViewport();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-980-stopped-starting-narrow.png") });
  },
);
