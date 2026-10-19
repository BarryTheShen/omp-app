/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePlaygroundBuilt } from "./playground-build";
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
 * T5.2 against real omp. The chat's fake-model prompt `spawn_steerable_subagent` makes omp start a real
 * subagent (the worker keeps taking steps). The check page (`src/modules/T5/task-playground.tsx`) runs the
 * app's own composition on the same server, with the same launch token, attaches to the folder's newest
 * chat, and renders its task card: the worker's transcript shows inside the card, read-only.
 */

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PAGE_NAME = "t5-2-task-card";
const PAGE_ROOT = join(DIST_ROOT, PAGE_NAME);
const WORKER_TASK = "nested_steer_child";
const CONTROL_NAMES = /edit|regenerate|branch|reload|compose|answer|approve|steer|send/i;

/** The check page is built into dist/ with the app's stylesheet, so the screenshots show real styles. */
function buildCheckPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T5/task-playground.tsx",
      "--outdir",
      `dist/${PAGE_NAME}`,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PAGE_ROOT).find((file) => file.endsWith(".js"));
  const ownCss = readdirSync(PAGE_ROOT).find((file) => file.endsWith(".css"));
  const appCss = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!js || !appCss) throw new Error("The T5.2 check page did not build with the app stylesheet.");
  const links = [
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
    `<link rel="stylesheet" href="/assets/${appCss}" />`,
    ownCss === undefined ? "" : `<link rel="stylesheet" href="/${PAGE_NAME}/${ownCss}" />`,
  ].join("\n    ");
  writeFileSync(
    join(DIST_ROOT, `${PAGE_NAME}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${links}
    <title>T5.2 task card check</title>
  </head>
  <body>
    <div id="t5-2-task-card-root"></div>
    <script type="module" src="/${PAGE_NAME}/${js}"></script>
  </body>
</html>
`,
  );
}

realTest.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildCheckPage();
  }),
);

realTest.setTimeout(240_000);

realTest(
  "a real subagent's transcript shows inside the task card, read-only, in light, dark and narrow",
  async ({ realApp, browser }) => {
    const app = await realApp.open();
    const composer = await startChat(app);
    await sendPrompt(composer, "spawn_steerable_subagent start the worker and wait for it");
    // The chat reports the spawn once omp has started the worker; the check page opens the chat then.
    await expect(app.getByText("Spawned agent").first()).toBeVisible({ timeout: 90_000 });

    const origin = new URL(app.url()).origin;
    const checkUrl = `${origin}/${PAGE_NAME}.html#token=${encodeURIComponent(realApp.token)}`;
    const check = await browser.newPage();
    const checkProblems: string[] = [];
    check.on("console", (message) => {
      if (message.type() === "error") checkProblems.push(`console error: ${message.text()}`);
    });
    check.on("pageerror", (error) => checkProblems.push(`page error: ${error.message}`));
    await check.goto(checkUrl);

    await expect(check.getByTestId("t5-2-task-check")).toBeVisible({ timeout: 30_000 });
    const background = await check
      .getByTestId("t5-2-task-check")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).not.toBe("rgba(0, 0, 0, 0)");

    const card = check.getByTestId("t5-task-card");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await openToolCard(card);
    const transcript = card.locator("[data-slot='t5-task-transcript']");
    await expect(transcript).toBeVisible({ timeout: 60_000 });
    // The worker is the subagent omp started for the task: its own task text is in its transcript.
    await expect(transcript).toContainText(WORKER_TASK, { timeout: 60_000 });
    await expect(transcript).toContainText("Read only");
    // Read-only: no edit, branch, reload, answer or steer control and no field inside the card's transcript.
    await expect(transcript.getByRole("button", { name: CONTROL_NAMES })).toHaveCount(0);
    await expect(transcript.locator("textarea, input")).toHaveCount(0);
    await expect(transcript.locator('[data-read-only="true"]').first()).toBeVisible();
    await waitForFiniteAnimations(check);
    await check.screenshot({ path: join(screenshots, "t5.2-light.png"), fullPage: true });

    await check.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(check);
    await expect(transcript).toContainText(WORKER_TASK);
    await check.screenshot({ path: join(screenshots, "t5.2-dark.png"), fullPage: true });

    await check.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(check);
    await check.screenshot({ path: join(screenshots, "t5.2-narrow.png"), fullPage: true });

    expect(checkProblems).toEqual([]);
    await check.close();
  },
);
