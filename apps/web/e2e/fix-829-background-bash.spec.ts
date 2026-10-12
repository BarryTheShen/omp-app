/// <reference types="node" />
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #829. A steer sent while a bash command runs makes omp move the command to the background. Its card must say
 * so with the job's number, and must not show omp's notice written for the model. `run_queued_pair` runs `sleep 20`
 * in bash; the steer is sent while it sleeps (the same run the queued-messages spec drives).
 */

const NOTE =
  /Running in the background as job bg_\d+\. Its output is added to the conversation when it finishes\./;
const OMP_NOTICE = ["Do NOT poll", "Backgrounded early", "log tailing"];
/** Tall enough for the whole short chat: the card's sticky header then needs no scroll, and stays under the chat's top bar. */
const DESKTOP_TALL = { width: 1280, height: 1000 } as const;
const NARROW = { width: 390, height: 844 } as const;

/** The app's styles are loaded: the shell's background is the theme's background token, not the browser default. */
async function expectStyledShell(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("");
  expect(colors.actual).toBe(colors.token);
}

/** Starts the run, steers it while the command sleeps, and returns the bash card once it says it runs in the background. */
async function backgroundedCard(page: Page, composer: Locator): Promise<Locator> {
  await sendPrompt(composer, "run_queued_pair");
  const card = page.getByTestId("u3-bash-card").filter({ hasText: "sleep 20; echo first" });
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 120_000,
  });
  await expect(card).toBeVisible({ timeout: 120_000 });
  // The card's note sits in its body, and the card starts as one line: open it to read the note.
  await openToolCard(card);
  await sendPrompt(composer, "steer while the command runs");
  await expect(card.getByText(NOTE)).toBeVisible({ timeout: 120_000 });
  // The turn ends after its write. Until then the chat follows its new output, and a capture would catch the card moving.
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 120_000,
  });
  return card;
}

/** The whole view, once the page's transitions have settled. */
async function captureView(page: Page, path: string): Promise<void> {
  await waitForFiniteAnimations(page);
  await page.screenshot({ path });
}

async function expectNoOmpNotice(page: Page): Promise<void> {
  for (const words of OMP_NOTICE) {
    await expect(page.getByText(words, { exact: false })).toHaveCount(0);
  }
}

realTest.setTimeout(420_000);

realTest(
  "real omp: a backgrounded command says so with its job, in the light theme",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await page.setViewportSize(DESKTOP_TALL);
    const card = await backgroundedCard(page, composer);
    await expect(card.getByText("In background", { exact: true })).toBeVisible();
    await expectNoOmpNotice(page);
    await expectStyledShell(page);
    await captureView(page, join(screenshots, "fix-829-background-light.png"));
    expect(realApp.problems).toEqual([]);
  },
);

realTest("real omp: a backgrounded command's note reads in the dark theme", async ({ realApp }) => {
  // The stored theme is applied before the first paint, so the page renders dark from its first frame.
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await page.setViewportSize(DESKTOP_TALL);
  await backgroundedCard(page, composer);
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await expectNoOmpNotice(page);
  await expectStyledShell(page);
  await captureView(page, join(screenshots, "fix-829-background-dark.png"));
  expect(realApp.problems).toEqual([]);
});

realTest("real omp: a backgrounded command's note fits at 390 px", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  // The chat starts at desktop width, where the sessions sidebar that starts it is shown; then the page narrows.
  const composer = await startChat(page);
  await page.setViewportSize(NARROW);
  await backgroundedCard(page, composer);
  await expectNoOmpNotice(page);
  await expectStyledShell(page);
  await captureView(page, join(screenshots, "fix-829-background-narrow.png"));
  expect(realApp.problems).toEqual([]);
});
