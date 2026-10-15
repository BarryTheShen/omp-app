/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { realTest, screenshots, sendPrompt, startChat } from "./real-omp";

const WEB_ROOT = process.cwd();
const DIST_ROOT = join(WEB_ROOT, "dist");

/** The Agent Hub's two pages: the fixture playground (every state) and the live one (real omp). */
const PLAYGROUNDS = [
  {
    entry: "src/modules/P1/panels/playground.tsx",
    outdir: "dist/p1-hub-playground",
    page: "p1-hub-playground.html",
    mount: "p1-hub-playground-root",
    script: "/p1-hub-playground/playground.js",
  },
  {
    entry: "src/modules/P1/panels/live-playground.tsx",
    outdir: "dist/p1-5-hub-live",
    page: "p1-5-hub-live.html",
    mount: "p1-5-hub-live-root",
    script: "/p1-5-hub-live/live-playground.js",
  },
] as const;

const BADGE = { name: "Jump to latest panel updates" };

function buildPlaygrounds(): void {
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the Agent Hub.");
  for (const playground of PLAYGROUNDS) {
    execFileSync(
      "bun",
      ["build", playground.entry, "--outdir", playground.outdir, "--target=browser"],
      { cwd: WEB_ROOT, stdio: "inherit" },
    );
    writeFileSync(
      join(DIST_ROOT, playground.page),
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="${playground.script}"></script>
  </head>
  <body>
    <div id="${playground.mount}"></div>
  </body>
</html>
`,
    );
  }
}

/** The page background is the `--background` token, not a browser default. */
async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("main").evaluate((main) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(main).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return {
      normalizedBackground: normalize(background),
      normalizedToken: normalize(token),
      token,
    };
  });
  expect(colors.token).not.toBe("");
  expect(colors.normalizedBackground).toBe(colors.normalizedToken);
}

function captureProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  return problems;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

/** The roster's own scroll container starts at its top: the first section is in view. */
async function expectRosterAtTop(page: Page): Promise<void> {
  const top = await page.locator('[data-panel-scroll="body"] > div').evaluate((roster) => {
    const heading = roster.querySelector("[role='listbox']");
    if (heading === null) throw new Error("The roster has no list.");
    return {
      scrollTop: roster.scrollTop,
      listTop: heading.getBoundingClientRect().top,
      rosterTop: roster.getBoundingClientRect().top,
    };
  });
  expect(top.scrollTop).toBe(0);
  expect(top.listTop).toBeLessThan(top.rosterTop + 40);
}

/** The value beside a fact's label in the inspector: factValue(page, "Tool calls") reads "6". */
function factValue(page: Page, label: string): Locator {
  return page
    .locator("div.contents", { has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) })
    .locator("dd");
}

/** Every worker title starts at one x, because the status column has one fixed width. */
async function expectTitlesInOneColumn(page: Page): Promise<void> {
  const lefts = await page
    .locator('[role="option"] div.font-medium')
    .evaluateAll((titles) => titles.map((title) => Math.round(title.getBoundingClientRect().left)));
  expect(lefts.length).toBeGreaterThan(1);
  expect(new Set(lefts).size).toBe(1);
}

test.describe("P1.5 Agent Hub playground", () => {
  test.beforeAll(() => {
    mkdirSync(screenshots, { recursive: true });
    buildPlaygrounds();
  });

  test("the populated hub lists every state with its inspector, opened without a badge", async ({
    page,
  }) => {
    const problems = captureProblems(page);
    await page.goto("/p1-hub-playground.html?scenario=populated");
    const region = page.getByRole("region", { name: "Agent Hub" });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute("data-panel-lifecycle", "populated");
    await expect(page.getByText("1 running · 1 queued · 3 recent")).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Active" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Recent" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Scan the repository/ })).toContainText(
      "Running",
    );
    await expect(page.getByRole("option", { name: /Plan the change/ })).toContainText("Queued");
    await expect(page.getByRole("option", { name: /Run the tests/ })).toContainText("Finished");
    await expect(page.getByRole("option", { name: /Review the diff/ })).toContainText("Cancelled");
    await expect(page.getByRole("option", { name: /Update the lockfile/ })).toContainText("Failed");
    await expect(page.getByRole("button", { name: "Cancel Scan the repository" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open transcript" })).toBeDisabled();
    await expect(
      page.getByText("The transcript view is not connected in this playground."),
    ).toBeVisible();
    // The scan worker is still running 90 s after its last report of 74 s, so its time has moved on to 2 min 44 s.
    await expect(page.getByText("Using read · 2 min 44 s")).toBeVisible();
    await expect(factValue(page, "Tool calls")).toHaveText("6");
    await expect(factValue(page, "Tokens")).toHaveText("18,240");
    await expect(factValue(page, "Requests")).toHaveText("3");
    await expect(factValue(page, "Model")).toHaveText("fixture-provider/fixture-model:high");
    await expect(page.getByText("$0.0213")).toBeVisible();
    await expectTitlesInOneColumn(page);
    const selectedWorker = page.getByRole("region", { name: "Selected worker" });
    await expect(selectedWorker).toBeVisible();
    const workerName = selectedWorker.locator("p").first();
    await expect(workerName).toHaveText("Scan the repository");
    // text-sm is U0's token (0.8125rem, tokens.css), the same size as the worker rows.
    await expect(workerName).toHaveCSS("font-size", "13px");
    await expect(workerName).toHaveCSS("font-weight", "600");
    await expect(page.getByRole("button", BADGE)).toHaveCount(0);
    await expectRosterAtTop(page);
    await expectTokenBackground(page);
    await page.screenshot({ path: join(screenshots, "p1.5-hub-light.png"), fullPage: true });
    expect(problems).toEqual([]);
  });

  test("the populated hub follows the dark theme and stays inside a narrow screen", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const root = document.documentElement;
      if (root) root.classList.add("dark");
      else
        document.addEventListener(
          "DOMContentLoaded",
          () => document.documentElement?.classList.add("dark"),
          { once: true },
        );
    });
    await page.goto("/p1-hub-playground.html?scenario=populated");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("region", { name: "Agent Hub" })).toBeVisible();
    await expectTokenBackground(page);
    await page.screenshot({ path: join(screenshots, "p1.5-hub-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Cancel Scan the repository" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: join(screenshots, "p1.5-hub-narrow.png"), fullPage: true });
  });

  test("a roster that arrives after the panel opened shows its top and no badge", async ({
    page,
  }) => {
    await page.goto("/p1-hub-playground.html?scenario=late-roster");
    await expect(page.getByRole("region", { name: "Agent Hub" })).toHaveAttribute(
      "data-panel-lifecycle",
      "loading",
    );
    await expect(page.getByRole("listbox", { name: "Active" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Agent Hub" })).toHaveAttribute(
      "data-panel-lifecycle",
      "populated",
    );
    await expect(page.getByRole("button", BADGE)).toHaveCount(0);
    await expectRosterAtTop(page);
    await expect(page.getByRole("option", { name: /Scan the repository/ })).toBeInViewport();
  });

  test("every other state reads in plain words with its own action", async ({ page }) => {
    const problems = captureProblems(page);
    const open = async (scenario: string) => {
      await page.goto(`/p1-hub-playground.html?scenario=${scenario}`);
      await expect(page.getByRole("region", { name: "Agent Hub" })).toBeVisible();
    };
    await open("loading");
    await expect(page.getByRole("region", { name: "Agent Hub" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.getByText("Loading", { exact: true })).toBeVisible();
    await open("empty");
    await expect(page.getByText("Nothing here yet")).toBeVisible();
    await open("error");
    await expect(page.getByText("The subagent roster request failed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await open("unavailable");
    await expect(page.getByText("This omp does not report its subagents.")).toBeVisible();
    await open("cancelling");
    await expect(page.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    await open("cancel-failed");
    await expect(
      page.getByText(
        "omp could not stop this worker now, because it is still running. Try Cancel again.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("option", { name: /Running.*Scan the repository/ })).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await page.screenshot({
      path: join(screenshots, "p1.5-hub-cancel-failed.png"),
      fullPage: true,
    });
    await open("transcript-open");
    await expect(page.getByRole("button", { name: "Open transcript" })).toBeEnabled();
    await open("by-parent");
    await page.getByRole("button", { name: "By parent" }).click();
    await expect(page.getByRole("button", { name: "By parent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("listbox", { name: "From task call 1" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Started from this chat" })).toBeVisible();
    expect(problems).toEqual([]);
  });
});

realTest(
  "real omp: the Agent Hub shows a finished, a failed and a running subagent as they happen, and cancels the running one",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    buildPlaygrounds();
    const page = await realApp.open();
    const composer = await startChat(page);
    // The chat's omp session exists once it has answered, so its id can name the page's chat.
    await sendPrompt(composer, "pong");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    const readThread = () =>
      page.evaluate(() => window.localStorage.getItem("omp.app.root.thread"));
    await expect.poll(readThread, { timeout: 60_000 }).toBeTruthy();
    const threadId = (await readThread()) ?? "";

    // The Hub opens before any subagent starts, so each transition reaches it as a live event.
    // A worker that ended before the Hub subscribed is gone from omp's registry, and cannot be shown.
    const origin = new URL(page.url()).origin;
    const browser = page.context().browser();
    if (browser === null) throw new Error("The browser is not available for the Agent Hub page.");
    const hubContext = await browser.newContext();
    const hub = await hubContext.newPage();
    const problems = captureProblems(hub);
    await hub.goto(
      `${origin}/p1-5-hub-live.html?thread=${encodeURIComponent(threadId)}#token=${encodeURIComponent(realApp.token)}`,
    );
    const hubRegion = hub.getByRole("region", { name: "Agent Hub" });
    await expect(hubRegion).toHaveAttribute("data-panel-lifecycle", "empty", { timeout: 90_000 });

    await sendPrompt(composer, "spawn_subagent");
    await expect(hub.getByRole("option", { name: /Finished/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(hub.getByRole("option", { name: /Finished.*NestedProbe/ })).toHaveCount(1);
    await sendPrompt(composer, "spawn_failing_subagent");
    await expect(hub.getByRole("option", { name: /Failed/ })).toHaveCount(1, { timeout: 120_000 });
    await expect(hub.getByRole("option", { name: /Failed.*FailProbe/ })).toHaveCount(1);
    await sendPrompt(composer, "spawn_long_subagent");
    const running = hub.getByRole("option", { name: /Running.*LongProbe/ });
    await expect(running).toHaveCount(1, { timeout: 120_000 });
    await expect(hub.getByRole("button", BADGE)).toHaveCount(0);
    await expectTokenBackground(hub);
    await hub.screenshot({ path: join(screenshots, "p1.5-hub-live-light.png"), fullPage: true });

    await running.click();
    const cancel = hub.getByRole("button", { name: /^Cancel / });
    await expect(cancel).toHaveCount(1);
    await expect(hub.getByRole("button", { name: "Open transcript" })).toBeEnabled();
    await cancel.click();
    await expect(hub.getByRole("option", { name: /Cancelled/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(hub.getByRole("button", { name: /^Cancel / })).toHaveCount(0);
    await expect(hub.getByRole("option", { name: /Running/ })).toHaveCount(0);
    await hub.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(hub);
    await hub.screenshot({ path: join(screenshots, "p1.5-hub-live-narrow.png"), fullPage: true });
    await hubContext.close();
    expect(problems).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a finished worker stays under Recent after a reload, and its transcript opens",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    buildPlaygrounds();
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    const readThread = () =>
      page.evaluate(() => window.localStorage.getItem("omp.app.root.thread"));
    await expect.poll(readThread, { timeout: 60_000 }).toBeTruthy();
    const threadId = (await readThread()) ?? "";

    const origin = new URL(page.url()).origin;
    const browser = page.context().browser();
    if (browser === null) throw new Error("The browser is not available for the Agent Hub page.");
    const hubContext = await browser.newContext();
    const hub = await hubContext.newPage();
    const problems = captureProblems(hub);
    await hub.goto(
      `${origin}/p1-5-hub-live.html?thread=${encodeURIComponent(threadId)}#token=${encodeURIComponent(realApp.token)}`,
    );
    await expect(hub.getByRole("region", { name: "Agent Hub" })).toHaveAttribute(
      "data-panel-lifecycle",
      "empty",
      { timeout: 90_000 },
    );

    await sendPrompt(composer, "spawn_subagent");
    await expect(hub.getByRole("option", { name: /Finished.*NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });

    // omp forgets a finished worker, so the reloaded page can list it only from the chat's transcripts.
    await hub.reload();
    const recent = hub.getByRole("option", { name: /Finished.*NestedProbe/ });
    await expect(recent).toHaveCount(1, { timeout: 120_000 });
    await recent.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    await expect(hub.getByTestId("p1-transcript-live")).toBeVisible();
    await expect(hub.getByRole("region", { name: "Transcript of NestedProbe" })).toBeVisible();
    await expect(
      hub.getByText("nested_probe_child: return a short result by calling yield."),
    ).toBeVisible();
    await hub.screenshot({
      path: join(screenshots, "p1.5-hub-finished-reload.png"),
      fullPage: true,
    });
    await hubContext.close();
    expect(problems).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);
