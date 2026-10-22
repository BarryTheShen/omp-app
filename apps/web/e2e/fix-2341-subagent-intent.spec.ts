/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  narrowTo,
  openToolCard,
  REAL_OMP,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #2341 on real omp: a subagent's running bash call names its intent on the task card's row, "Running bash: <intent>",
 * and the row drops the call once the call ends. The fake model starts the subagent with `spawn_intent_subagent N`; the
 * child's one bash call sleeps N seconds with an intent (the `i` argument). With an omp older than 18.12.1 this skips:
 * 18.12.1 is the oldest omp checked to send a call's intent in subagent progress (`task/executor.ts:1831-1834` there).
 */

const RUNNING = "Running bash: Waiting for the subagent's fixture command";
const NEEDS_OMP = "needs omp 18.12.1 or newer";

/** A subagent type that runs inline: `blocking: true` makes the parent wait on the child, so its call is foreground. */
const FOREGROUND_AGENT = [
  "---",
  "name: fgprobe",
  "description: Foreground probe that runs one step inline for a spec.",
  "blocking: true",
  "---",
  "Complete the assignment with the tools you have.",
  "",
].join("\n");

/** Whether this omp sends a tool call's intent, judged by its version: 18.12.1 is the oldest checked to send it. */
function ompSendsToolIntent(omp: string): boolean {
  const result = spawnSync(omp, ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  const printed = `${result.stdout}${result.stderr}`;
  const match = /omp\/(\d+)\.(\d+)\.(\d+)/.exec(printed);
  if (match === null) throw new Error(`omp --version printed no version: ${printed}`);
  const [major = 0, minor = 0, patch = 0] = [match[1], match[2], match[3]].map((part) =>
    Number(part),
  );
  return major > 18 || (major === 18 && (minor > 12 || (minor === 12 && patch >= 1)));
}

// The row's counts are drawn with the muted token: a probe with that colour must match its computed colour before
// anything is captured, so a screenshot cannot show browser defaults.
async function expectTokenColor(text: Locator): Promise<void> {
  const colors = await text.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.color = "var(--muted-foreground)";
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(element).color, token };
  });
  expect(colors.token).not.toBe("rgb(0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
}

// Scrolls the task card into view, waits for the animations to finish, then captures the page.
async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

realTest.setTimeout(240_000);

realTest(
  "real omp: a subagent's running bash call names its intent on the task card row, in light, dark and 390 px, and the row drops it when the call ends",
  async ({ realApp, ompBinary }, testInfo) => {
    testInfo.skip(!ompSendsToolIntent(ompBinary ?? REAL_OMP), NEEDS_OMP);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_intent_subagent 9");

    const card = page.getByTestId("t5-task-card").first();
    await openToolCard(card);
    const row = card.locator('[data-slot="t5-task-progress"] li').first();
    await expect(row).toContainText(RUNNING, { timeout: 90_000 });
    const counts = row.locator("p").first();
    await expectTokenColor(counts);
    await capture(page, "fix-2341-subagent-running-light.png", card);

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectTokenColor(counts);
    await capture(page, "fix-2341-subagent-running-dark.png", card);
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await narrowTo(page);
    await expect(row).toContainText(RUNNING);
    await expectTokenColor(counts);
    await capture(page, "fix-2341-subagent-running-390.png", card);

    // The child's call ends after its sleep: the row no longer says it is running that call.
    await expect(row).not.toContainText("Running bash", { timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a foreground subagent's running bash call names its intent on the task card row, and the row drops it when the call ends",
  async ({ realApp, ompBinary }, testInfo) => {
    testInfo.skip(!ompSendsToolIntent(ompBinary ?? REAL_OMP), NEEDS_OMP);
    // The child's type declares `blocking: true`, so omp runs the task call inline and the parent waits on the child.
    // omp reads user agents from `~/.omp/agent/agents`; the fixture runs omp with HOME at `<root>/home`, beside its agent folder.
    const agents = join(dirname(realApp.agentDir), "home", ".omp", "agent", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "fgprobe.md"), FOREGROUND_AGENT);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_foreground_intent 9");

    const card = page.getByTestId("t5-task-card").first();
    await openToolCard(card);
    // An inline call is not a background job: the card shows no job row.
    await expect(card.locator('[data-slot="t5-task-job"]')).toHaveCount(0);
    const row = card.locator('[data-slot="t5-task-progress"] li').first();
    await expect(row).toContainText(RUNNING, { timeout: 90_000 });
    await capture(page, "fix-2341-foreground-running-light.png", card);

    // The child's call ends after its sleep. An inline call then lists the child's result in place of the agent row,
    // and the card no longer names that call.
    await expect(card.getByRole("listitem").filter({ hasText: "Completed" })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(card).not.toContainText("Running bash");
    expect(realApp.problems).toEqual([]);
  },
);
