import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REAL_OMP, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's side column (`apps/ui/src/panels`) on real omp, and Usage, its first panel: the key, the button and the
 * palette show and hide it, it stays open across a reload, it follows the focused pane's chat, Usage shows the chat's
 * numbers (read again when a turn ends) and the accounts' limits from omp's usage report, and on a phone it is a sheet.
 */
const MINUTE = 60_000;

/**
 * `omp usage --json`'s shape (as `fix-1163-usage-bars.spec.ts` builds it), each reset set from the time the spec starts:
 * anthropic's two windows, cursor's month, and openai-codex's "5 hours" window for two accounts.
 */
function usageFixture(now: number): unknown {
  const limitWindow = (id: string, label: string, resetMinutes: number) => ({
    id,
    label,
    resetsAt: now + resetMinutes * MINUTE,
  });
  const limit = (id: string, label: string, usedFraction: number, resetMinutes: number) => ({
    id,
    label,
    window: limitWindow(id, label, resetMinutes),
    amount: { usedFraction },
  });
  const report = (provider: string, limits: unknown[]) => ({
    provider,
    fetchedAt: now,
    metadata: {},
    limits,
  });
  return {
    generatedAt: now,
    reports: [
      report("anthropic", [
        limit("anthropic:5h", "5 Hour", 0.04, 125),
        limit("anthropic:7d", "7 Day", 0.8, 3 * 24 * 60 + 4 * 60),
      ]),
      report("cursor", [limit("cursor:monthly", "Monthly", 0, 26 * 60)]),
      report("openai-codex", [limit("openai-codex:5h", "5 hours", 0.95, 3 * 60)]),
      report("openai-codex", [limit("openai-codex:5h", "5 hours", 0.2, 3 * 60 + 30)]),
    ],
  };
}

// A stand-in for omp: `omp usage` prints the fixture, and every other call runs the real omp.
const FIXTURE_DIRECTORY = mkdtempSync(join(tmpdir(), "omp-app-v2-panel-usage-"));
const FIXTURE_FILE = join(FIXTURE_DIRECTORY, "usage.json");
const WRAPPER = join(FIXTURE_DIRECTORY, "omp");
writeFileSync(FIXTURE_FILE, `${JSON.stringify(usageFixture(Date.now()))}\n`);
writeFileSync(
  WRAPPER,
  `#!/bin/sh\nif [ "$1" = "usage" ]; then cat "${FIXTURE_FILE}"; exit 0; fi\nexec "${REAL_OMP}" "$@"\n`,
);
chmodSync(WRAPPER, 0o755);
realTest.use({ ompBinary: WRAPPER });

const panel = (page: Page) => page.getByRole("complementary", { name: "Side panel" });
const thisChat = (page: Page) => page.getByRole("region", { name: "This chat" });
const accounts = (page: Page) => page.getByRole("region", { name: "Your accounts" });
const numbers = (page: Page, title: string) => thisChat(page).getByRole("group", { name: title });
/** A panel's button on the rail at the window's right edge. */
const railButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Side panel" }).getByRole("button", { name });

const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });

async function send(page: Page, index: number, text: string, answers: number): Promise<void> {
  await boxes(page).nth(index).fill(text);
  await boxes(page).nth(index).press("Enter");
  await expect(page.getByText("pong", { exact: true })).toHaveCount(answers, { timeout: 90_000 });
}

realTest.describe("new UI side panel", () => {
  realTest.setTimeout(240_000);

  realTest(
    "the key, the rail and the palette show and hide it, and it stays open after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
      await expect(panel(page)).toHaveCount(0);
      await expect(railButton(page, "Usage")).toHaveAttribute("aria-pressed", "false");

      await page.keyboard.press("Control+Alt+KeyB");
      await expect(panel(page)).toBeVisible();
      // A pane of the workspace: its title is in the pane's title bar, and the panel it shows is named.
      await expect(panel(page).getByRole("tabpanel", { name: "Usage" })).toBeVisible();
      await expect(railButton(page, "Usage")).toHaveAttribute("aria-pressed", "true");
      // The rail's button of the panel shown puts it away; another one shows its own panel.
      await railButton(page, "Usage").click();
      await expect(panel(page)).toHaveCount(0);
      await railButton(page, "Progress").click();
      await expect(panel(page).getByRole("tabpanel", { name: "Progress" })).toBeVisible();
      await expect(railButton(page, "Progress")).toHaveAttribute("aria-pressed", "true");
      await expect(railButton(page, "Usage")).toHaveAttribute("aria-pressed", "false");
      await railButton(page, "Progress").click();
      await expect(panel(page)).toHaveCount(0);

      await page.keyboard.press("Control+k");
      const search = page
        .getByRole("dialog", { name: "Palette", exact: true })
        .getByRole("combobox", { name: "Search the palette" });
      await search.fill("Side panel: Usage");
      await search.press("Enter");
      await expect(panel(page)).toBeVisible();

      await page.reload();
      await expect(panel(page).getByRole("tabpanel", { name: "Usage" })).toBeVisible({
        timeout: 30_000,
      });
      // The panel kept from before the reload draws its content at once, not only its title (#2773).
      await expect(accounts(page)).toBeVisible();
      await railButton(page, "Usage").click();
      await expect(panel(page)).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Usage shows the accounts' limits, and the focused chat's numbers, read again after each turn",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Control+Alt+KeyB");
      await expect(thisChat(page)).toContainText("Open a chat to see its usage.");

      // omp's usage report, one bar per window: the share, the tone, the fullest account and the time left.
      await expect(
        accounts(page).getByRole("progressbar", { name: "anthropic, 5 hour limit" }),
      ).toHaveAttribute("aria-valuenow", "4", { timeout: 90_000 });
      await expect(
        accounts(page).getByRole("progressbar", { name: "anthropic, 7 day limit" }),
      ).toHaveAttribute("data-tone", "warning");
      const fullest = accounts(page).getByRole("progressbar", {
        name: "openai-codex, 5 hours limit",
      });
      await expect(fullest).toHaveAttribute("aria-valuenow", "95");
      await expect(fullest).toHaveAttribute("data-tone", "danger");
      await expect(accounts(page).getByText(/the fullest of 2 accounts/)).toBeVisible();
      // The fixture's resets count from when this file loaded, so the minutes have moved on a little by now.
      await expect(
        accounts(page)
          .getByText(/resets in 2 h \d+ min/)
          .first(),
      ).toBeVisible();

      // The focused chat's numbers, as omp's /session counts them.
      await startNewChat(page);
      await expect(boxes(page).first()).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
      await send(page, 0, "hello", 1);
      const user = numbers(page, "Messages").getByRole("definition").first();
      await expect(user).toHaveText("1", { timeout: 30_000 });
      await expect(numbers(page, "Tokens")).toBeVisible();
      await expect(thisChat(page).getByRole("progressbar", { name: "Context used" })).toBeVisible();
      // A turn's end reads them again.
      await send(page, 0, "hello again", 2);
      await expect(user).toHaveText("2", { timeout: 30_000 });

      // A new window's chat is focused: its own numbers; back in the first window, the first chat's.
      await page.keyboard.press("Control+Shift+O");
      await page.keyboard.press("Enter");
      await expect(boxes(page).nth(1)).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
      await expect(user).toHaveText("0", { timeout: 30_000 });
      await boxes(page).first().click();
      await expect(user).toHaveText("2", { timeout: 30_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a chat in the middle of a turn shows its numbers without waiting for the turn to end",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(boxes(page).first()).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
      // The fake model streams this reply for about a minute.
      await boxes(page).first().fill("stream_steady");
      await boxes(page).first().press("Enter");
      const stop = page.getByRole("button", { name: "Stop" });
      await expect(stop).toBeVisible({ timeout: 60_000 });

      // Usage opened during the turn, on a page that never read this chat: its numbers come within a read.
      await page.keyboard.press("Control+Alt+KeyB");
      const user = numbers(page, "Messages").getByRole("definition").first();
      await expect(user).toHaveText("1", { timeout: 20_000 });
      await expect(stop).toBeVisible();

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Progress shows the todo list, sets and pauses a goal and turns plan mode on; Agents lists a subagent and opens the Agent Hub on it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(boxes(page).first()).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
      await page.keyboard.press("Control+Alt+KeyB");
      const tab = (name: string) => railButton(page, name);

      // Progress: no goal yet; omp's todo list as omp writes it.
      await tab("Progress").click();
      await expect(tab("Progress")).toHaveAttribute("aria-pressed", "true");
      const progress = panel(page).getByRole("tabpanel", { name: "Progress" });
      await expect(progress).toContainText("No goal in this chat.");
      await expect(progress).toContainText("omp keeps no todo list in this chat.");
      await boxes(page).first().fill("make_todos");
      await boxes(page).first().press("Enter");
      const todos = progress.getByRole("region", { name: "Todos", exact: true });
      await expect(todos.getByRole("listitem", { name: "Now: Write the thing" })).toBeVisible({
        timeout: 60_000,
      });
      await expect(todos.getByRole("listitem", { name: "To do: Test the thing" })).toBeVisible();
      await expect(progress).toContainText("0/2 done");

      // A goal set from the panel, then paused there.
      await progress.getByRole("button", { name: "Set a goal…" }).click();
      const dialog = page.getByRole("dialog", { name: "Set a goal" });
      await dialog.getByRole("textbox", { name: "Objective" }).fill("Ship the release");
      await dialog.getByRole("button", { name: "Set goal" }).click();
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });
      const goal = progress.getByRole("region", { name: "Goal", exact: true });
      await expect(goal).toContainText("Ship the release", { timeout: 30_000 });
      await expect(goal).toContainText("Working on it");
      await goal.getByRole("button", { name: "Pause" }).click();
      await expect(goal).toContainText("Paused");
      await goal.getByRole("button", { name: "Drop" }).click();
      await expect(progress).toContainText("No goal in this chat.");

      // Plan mode (omp offers it here: the box shows its chip) turns on and off from the panel.
      await progress.getByRole("button", { name: "Turn on" }).click();
      await expect(progress).toContainText("On: omp plans and changes nothing until you approve.");
      await progress.getByRole("button", { name: "Turn off" }).click();
      await expect(progress).toContainText("Off: omp works on the chat directly.");

      // Agents: the chat's subagent, live; a click opens the Agent Hub on it, where Kill stops it.
      await tab("Agents").click();
      const agents = panel(page).getByRole("tabpanel", { name: "Agents" });
      await expect(agents).toContainText("No subagents in this chat yet.");
      await boxes(page).first().fill("spawn_long_subagent");
      await boxes(page).first().press("Enter");
      const row = agents.getByRole("button", { name: /^LongProbe: / });
      await expect(row).toHaveAccessibleName(/^LongProbe: \S+, running/, { timeout: 60_000 });
      await row.click();
      const hub = page.getByRole("complementary", { name: "Agent Hub" });
      const agent = hub.getByRole("region", { name: "LongProbe", exact: true });
      await expect(agent).toBeVisible();
      await agent.getByRole("button", { name: "Kill" }).click();
      await expect(row).toHaveAccessibleName(/^LongProbe: \S+, aborted/, { timeout: 30_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "on a phone a chat's details open from its top bar as a screen of their own, with named tabs, and ‹ Chat goes back",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });

      await page.getByRole("button", { name: "Details" }).tap();
      const details = page.getByRole("region", { name: "Chat details" });
      await expect(details).toBeVisible();
      await expect(box).toBeHidden();
      const tabs = details.getByRole("tab");
      await expect(tabs).toHaveText([
        "Usage",
        "Agents",
        "Progress",
        "Jobs",
        "BTW history",
        "Files",
        "Ports",
      ]);
      const heights = await tabs.evaluateAll((all) =>
        all.map((tab) => tab.getBoundingClientRect().height),
      );
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
      await expect(details.getByRole("region", { name: "Your accounts" })).toBeVisible();
      await details.getByRole("tab", { name: "Jobs" }).tap();
      await expect(details.getByRole("tabpanel", { name: "Jobs" })).toBeVisible();

      await details.getByRole("button", { name: "Chat", exact: true }).tap();
      await expect(details).toHaveCount(0);
      await expect(box).toBeVisible();

      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
