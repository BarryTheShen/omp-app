/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePlaygroundBuilt } from "./playground-build";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * P1.4 against real omp. The chat's fake-model prompt `spawn_steerable_subagent` makes omp start a real
 * subagent that keeps working until a message starting with `steer_probe:` reaches it. The check page
 * (`src/modules/P1/transcript/playground.tsx`) runs the app's own composition on the same server, with the
 * same launch token, opens the folder's latest chat, and shows that worker's transcript through the
 * focused view.
 */

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PAGE_NAME = "p1-4-transcript";
const PAGE_ROOT = join(DIST_ROOT, PAGE_NAME);
const STEER_TEXT = "steer_probe: wrap up now";
const WORKER_TASK = "nested_steer_child";
const CONTROL_NAMES = /edit|regenerate|branch|reload|compose|answer|approve|steer|send/i;

/** The check page is built into dist/ with the app's stylesheet, so the screenshots show real styles. */
function buildCheckPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P1/transcript/playground.tsx",
      "--outdir",
      `dist/${PAGE_NAME}`,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PAGE_ROOT).find((file) => file.endsWith(".js"));
  const ownCss = readdirSync(PAGE_ROOT).find((file) => file.endsWith(".css"));
  const appCss = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!js || !appCss) throw new Error("The P1.4 check page did not build with the app stylesheet.");
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
    <title>P1.4 worker transcript check</title>
  </head>
  <body>
    <div id="p1-4-transcript-root"></div>
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
  "a real subagent's transcript is read-only, and a steer reaches the running worker",
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

    await expect(check.getByTestId("p1-4-transcript-check")).toBeVisible({ timeout: 30_000 });
    const background = await check
      .getByTestId("p1-4-transcript-check")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(background).not.toBe("rgba(0, 0, 0, 0)");

    const transcript = check.getByRole("region", { name: "Worker messages" });
    await expect(transcript).toBeVisible({ timeout: 60_000 });
    // The worker is the subagent omp started for the task: its own task text is in its transcript.
    await expect(transcript).toContainText(WORKER_TASK, { timeout: 60_000 });
    // Read-only: no edit, branch, reload, answer or steer control and no field inside the transcript.
    await expect(transcript.getByRole("button", { name: CONTROL_NAMES })).toHaveCount(0);
    await expect(transcript.locator("textarea, input")).toHaveCount(0);
    await expect(check.locator('[data-read-only="true"]').first()).toBeVisible();

    // The editor is on while the worker runs, and a message sent from it reaches that worker.
    const editor = check.getByRole("textbox", { name: "Message to this worker" });
    await expect(editor).toBeEnabled({ timeout: 30_000 });
    await waitForFiniteAnimations(check);
    await check.screenshot({ path: join(screenshots, "p1-4-light.png"), fullPage: true });
    await editor.fill(STEER_TEXT);
    await editor.press("Enter");
    await expect(transcript).toContainText(STEER_TEXT, { timeout: 60_000 });

    // The worker took the message as its next instruction, yielded, and the view shows it finished.
    await expect(check.getByText("Finished · read-only")).toBeVisible({ timeout: 120_000 });
    await expect(editor).toBeDisabled();

    // The finished worker is still in this page's roster; a new page would not list it, because omp drops a
    // finished worker from its live registry. The dark look is the same page with the class added.
    await check.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(check);
    await expect(transcript).toContainText(STEER_TEXT);
    await check.screenshot({ path: join(screenshots, "p1-4-dark.png"), fullPage: true });

    await check.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(check);
    await check.screenshot({ path: join(screenshots, "p1-4-narrow.png"), fullPage: true });

    expect(checkProblems).toEqual([]);
    await check.close();
  },
);
