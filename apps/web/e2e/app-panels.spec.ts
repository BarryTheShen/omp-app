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
 * The right-hand panels against real omp, in the app itself: the conversation tree (P4.4, rewinding
 * through R0.4's branch) and the Agent Hub with a worker's focused transcript (P1.4 and P1.5). The fake
 * model answers "pong" to anything without a keyword, and starts real subagents for the spawn keywords.
 */

const TREE = { name: "Conversation messages" } as const;
const HISTORY_TAB = { name: "Conversation history" } as const;
const CHORD = "Control+Shift+H";
const NARROW = { width: 390, height: 844 } as const;

/** Sends one message and waits until omp's reply is on screen, so each turn is a finished exchange. */
async function exchange(
  page: Page,
  composer: Locator,
  text: string,
  replies: number,
): Promise<void> {
  await sendPrompt(composer, text);
  await expect(page.getByText("pong", { exact: true })).toHaveCount(replies, { timeout: 90_000 });
}

/** The element with focus has this ARIA role (the tree rows are `treeitem`s). */
async function expectFocusRole(page: Page, role: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("role") ?? null), {
      timeout: 15_000,
    })
    .toBe(role);
}

/** The right sidebar is open (`data-open`) or collapsed; it is the panels column of the shell. */
async function expectPanelsOpen(page: Page, open: boolean): Promise<void> {
  await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
    "data-open",
    open ? "true" : "false",
  );
}

/** Every tab of the right sidebar lies inside the sidebar's box: none is clipped by one of its edges. */
async function expectTabsInsideSidebar(page: Page): Promise<void> {
  const sidebar = page.locator('[data-shell-sidebar="right"]');
  const box = await sidebar.boundingBox();
  if (box === null) throw new Error("The right sidebar has no box.");
  const tabs = sidebar.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const tab = await tabs.nth(index).boundingBox();
    if (tab === null) throw new Error(`Panel tab ${index} has no box.`);
    expect(tab.x, `tab ${index} starts inside the sidebar`).toBeGreaterThanOrEqual(box.x);
    expect(tab.y, `tab ${index} starts inside the sidebar`).toBeGreaterThanOrEqual(box.y);
    expect(tab.x + tab.width, `tab ${index} ends inside the sidebar`).toBeLessThanOrEqual(
      box.x + box.width,
    );
    expect(tab.y + tab.height, `tab ${index} ends inside the sidebar`).toBeLessThanOrEqual(
      box.y + box.height,
    );
  }
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function darkLook(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await settle(page);
}

realTest.setTimeout(420_000);

realTest(
  "the conversation tree opens from the palette, and rewinding to an earlier message shows the earlier chat",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await exchange(page, composer, "alpha question", 1);
    await exchange(page, composer, "bravo question", 2);
    await exchange(page, composer, "charlie question", 3);

    await composer.focus();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox", { name: "Search commands" }).fill("conversation tree");
    const row = palette.getByRole("option", { name: /Conversation tree/ });
    // The palette row shows the chord that runs the same panel.
    await expect(row).toContainText("Ctrl+Shift+H");
    await row.click();

    const tree = page.getByRole("tree", TREE);
    await expect(page.getByRole("tab", HISTORY_TAB)).toHaveAttribute("aria-selected", "true");
    await expect(tree.getByRole("treeitem", { name: /alpha question/ })).toBeVisible();
    await expectFocusRole(page, "treeitem");

    // Enter marks the second question; Enter on the marked message rewinds to it.
    const bravo = tree.getByRole("treeitem", { name: /bravo question/ });
    await bravo.click();
    await bravo.press("Enter");

    // omp's branch keeps the path up to the question's parent: the first exchange, and nothing after.
    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    await expect(transcript.getByText("alpha question", { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(transcript.getByText("bravo question", { exact: true })).toHaveCount(0);
    await expect(transcript.getByText("charlie question", { exact: true })).toHaveCount(0);
    await expect(tree).toBeHidden();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the chord opens the tree from a collapsed sidebar, moves focus in, and Escape returns it to the composer",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await exchange(page, composer, "alpha question", 1);
    await exchange(page, composer, "bravo question", 2);

    await page.getByRole("button", { name: "Hide panels sidebar" }).click();
    await expectPanelsOpen(page, false);

    await composer.focus();
    await page.keyboard.press(CHORD);
    await expectPanelsOpen(page, true);
    const tree = page.getByRole("tree", TREE);
    await expect(tree.getByRole("treeitem", { name: /bravo question/ })).toBeVisible();
    await expectFocusRole(page, "treeitem");

    // Focus starts on the last row, so the arrow keys are checked upwards and then back down.
    const first = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-tree-entry-id"),
    );
    await page.keyboard.press("ArrowUp");
    const above = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-tree-entry-id"),
    );
    expect(above).not.toBe(first);
    await page.keyboard.press("ArrowDown");
    const back = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-tree-entry-id"),
    );
    expect(back).toBe(first);

    await settle(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-rewind-light.png"),
      fullPage: true,
    });
    await darkLook(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-rewind-dark.png"),
      fullPage: true,
    });

    // The narrow layout closes both sidebars once it applies; the chord reopens the tree after that.
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await expectPanelsOpen(page, false);
    await page.keyboard.press(CHORD);
    await expectPanelsOpen(page, true);
    await expect(tree).toBeVisible();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-rewind-narrow.png"),
      fullPage: true,
    });

    await page.keyboard.press("Escape");
    await expect(tree).toBeHidden();
    await expect(composer).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Agent Hub lists a real worker, opens its transcript, takes a message from the editor, and cancels the long one",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.getByRole("tab", { name: "Agents" }).click();

    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub).toHaveAttribute("data-panel-lifecycle", "empty", { timeout: 90_000 });

    // A steerable worker keeps working until a message reaches it.
    await sendPrompt(composer, "spawn_steerable_subagent start the worker and wait for it");
    const steerable = hub.getByRole("option", { name: /Running/ });
    await expect(steerable).toHaveCount(1, { timeout: 120_000 });
    await steerable.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();

    const transcript = page.getByRole("region", { name: /^Transcript of / });
    await expect(transcript).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeFocused();

    const editor = page.getByRole("textbox", { name: "Message to this worker" });
    await expect(editor).toBeEnabled({ timeout: 60_000 });
    await editor.fill("steer_probe: wrap up now");
    await editor.press("Enter");
    await expect(transcript).toContainText("steer_probe: wrap up now", { timeout: 120_000 });
    await expect(page.getByText("Finished · read-only")).toBeVisible({ timeout: 180_000 });
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-agents-light.png"),
      fullPage: true,
    });

    // With the editor disabled, focus is put back into the transcript; Escape leaves it for the hub.
    await page.getByRole("region", { name: "Worker messages" }).focus();
    await page.keyboard.press("Escape");
    await expect(hub).toBeVisible();

    await sendPrompt(composer, "spawn_long_subagent");
    const running = hub.getByRole("option", { name: /Running/ });
    await expect(running).toHaveCount(1, { timeout: 120_000 });
    await running.click();
    await hub.getByRole("button", { name: /^Cancel / }).click();
    await expect(hub.getByRole("option", { name: /Cancelled/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(hub.getByRole("button", { name: /^Cancel / })).toHaveCount(0);

    await darkLook(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-agents-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await expectPanelsOpen(page, false);
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    await expect(hub).toBeVisible();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-agents-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a task card in the chat shows its worker's read-only transcript, with the Agents tab never opened",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");

    // The card starts the chat's roster on its own: its worker's transcript is read by the card, not by the tab.
    const card = page.getByTestId("t5-task-card");
    await expect(card).toBeVisible({ timeout: 120_000 });
    await openToolCard(card);
    const transcript = card.locator('[data-slot="t5-task-transcript"]');
    await expect(transcript).toContainText("Read only", { timeout: 120_000 });
    await expect(transcript).toContainText("nested_probe_child", { timeout: 120_000 });
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Holds the answer to the roster's first setSubagentSubscription for `ms`: the roster is not subscribed until then,
 * so a worker that starts and ends in the meantime is never announced to it, as on a busy machine.
 */
async function holdRosterSubscription(page: Page, ms: number): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    let subscribeCall: string | undefined;
    let held = false;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type === "call" && frame.method === "setSubagentSubscription" && !held) {
        subscribeCall = String(frame.id);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type === "result" && subscribeCall !== undefined && frame.id === subscribeCall) {
        held = true;
        subscribeCall = undefined;
        setTimeout(() => ws.send(message), ms);
        return;
      }
      ws.send(message);
    });
  });
}

realTest(
  "a worker that ended before the roster subscribed shows under its task card, with its transcript",
  async ({ realApp }) => {
    const page = await realApp.open({ beforeLoad: (page) => holdRosterSubscription(page, 5_000) });
    const composer = await startChat(page);
    // The chat has loaded (the thread shows its empty state, not "Loading conversation"): a prompt typed while it
    // loads is lost when the draft loads.
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(composer, "spawn_subagent");

    // The card starts the roster, whose subscription is held until the worker has ended: the worker's end is
    // only known from its transcript, and the card must show that end.
    const card = page.getByTestId("t5-task-card");
    await expect(card).toBeVisible({ timeout: 120_000 });
    await openToolCard(card);
    await expect(card.locator('[data-slot="t5-task-transcript"]')).toContainText("Read only", {
      timeout: 60_000,
    });
    const progress = card.locator('[data-slot="t5-task-progress"]');
    await expect(progress).toContainText("Completed");
    await expect(progress).not.toContainText("Pending");
    // The parent turn runs on after the worker ends (its job result, then its reply): wait for it to settle before
    // the card is scrolled and shot, as the sibling specs do.
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    // The thread runs on below the card: open the card and bring it into view, so each shot shows the worker. The chat
    // keeps each message's element across its history reloads (issue 1047), so the card is found once and the scroll
    // does not need to retry.
    const trigger = card.locator('[data-slot="u3-tool-card-trigger"]').first();
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-finished-worker-light.png"),
    });
    await darkLook(page);
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-finished-worker-dark.png"),
    });
    await page.setViewportSize(NARROW);
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "app-panels-finished-worker-narrow.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the five tabs stay inside the sidebar at 1280 px; only the history panel draws Close, and it closes its tab",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await exchange(page, composer, "alpha question", 1);

    await composer.focus();
    await page.keyboard.press(CHORD);
    const sidebar = page.locator('[data-shell-sidebar="right"]');
    await expect(page.getByRole("tab", HISTORY_TAB)).toHaveAttribute("aria-selected", "true");
    await expect(sidebar.getByRole("tab")).toHaveCount(5);
    await expectTabsInsideSidebar(page);

    // The Todo checklist, Rules and Agent Hub are tabs with nothing to close, so they draw no Close control.
    await sidebar.getByRole("tab", { name: "Rules" }).click();
    await expect(page.getByRole("region", { name: "Rules", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Rules" })).toHaveCount(0);
    await sidebar.getByRole("tab", { name: "Todo checklist" }).click();
    await expect(page.getByRole("button", { name: "Close Todo checklist" })).toHaveCount(0);
    await sidebar.getByRole("tab", { name: "Agents" }).click();
    await expect(page.getByRole("region", { name: "Agent Hub" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Agent Hub" })).toHaveCount(0);

    // The history panel's Close works: it closes its tab, and the other four remain.
    await sidebar.getByRole("tab", HISTORY_TAB).click();
    await page.getByRole("button", { name: "Close Conversation history" }).click();
    await expect(sidebar.getByRole("tab")).toHaveCount(4);
    await expect(page.getByRole("tab", HISTORY_TAB)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a finished worker's yield reads as finished with its result, and a live worker's pending call reads as running",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub).toHaveAttribute("data-panel-lifecycle", "empty", { timeout: 90_000 });

    // The steerable worker takes a steer and then yields. The number of yields depends on whether its bash step was
    // still running, so the checks below do not count them.
    await sendPrompt(composer, "spawn_steerable_subagent start the worker and wait for it");
    await expect(hub.getByRole("option", { name: /Running/ })).toHaveCount(1, { timeout: 120_000 });
    await hub.getByRole("option", { name: /Running/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const transcript = page.getByRole("region", { name: /^Transcript of / });
    await expect(transcript).toBeVisible({ timeout: 60_000 });
    const editor = page.getByRole("textbox", { name: "Message to this worker" });
    await expect(editor).toBeEnabled({ timeout: 60_000 });
    await editor.fill("steer_probe: wrap up now");
    await editor.press("Enter");
    await expect(page.getByText("Finished · read-only")).toBeVisible({ timeout: 180_000 });

    // Finished: each yield's result is recorded, so its yield reads as finished, and none reads as unrecorded,
    // partial or Streaming.
    const yieldCard = transcript.locator('[data-testid^="tool-card-call_yield"]').first();
    await expect(yieldCard).toHaveAttribute("data-phase", "success", { timeout: 60_000 });
    await expect(transcript.locator('[data-phase="unrecorded"]')).toHaveCount(0);
    await expect(transcript.getByText("No result recorded")).toHaveCount(0);
    await expect(transcript.locator('[data-phase="partial"]')).toHaveCount(0);
    await expect(transcript.getByText("Streaming", { exact: true })).toHaveCount(0);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "yield-finished-light.png"), fullPage: true });
    await darkLook(page);
    await page.screenshot({ path: join(screenshots, "yield-finished-dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.getByRole("button", { name: "Back", exact: true }).click();

    // Live: the long worker's pending bash call is still running, so it reads as Running, never as Streaming.
    await sendPrompt(composer, "spawn_long_subagent");
    const running = hub.getByRole("option", { name: /Running/ });
    await expect(running).toHaveCount(1, { timeout: 120_000 });
    await running.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const live = page.getByRole("region", { name: /^Transcript of / });
    await expect(live.locator('[data-phase="running"]').first()).toBeVisible({ timeout: 60_000 });
    await expect(live.locator('[data-phase="unrecorded"]')).toHaveCount(0);
    await expect(live.getByText("Streaming", { exact: true })).toHaveCount(0);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "yield-live-light.png"), fullPage: true });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await hub.getByRole("button", { name: /^Cancel / }).click();
    await expect(hub.getByRole("option", { name: /Cancelled/ })).toHaveCount(1, {
      timeout: 60_000,
    });

    // The finished worker again, in the narrow drawer: the panel is shown, and its yields still read as finished.
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await expectPanelsOpen(page, false);
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    await hub.getByRole("option", { name: /SteerProbe/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    await expect(transcript).toBeVisible();
    await expect(transcript.locator('[data-phase="unrecorded"]')).toHaveCount(0);
    await expect(
      transcript.locator('[data-testid^="tool-card-call_yield"]').first(),
    ).toHaveAttribute("data-phase", "success");
    await expect(transcript.locator('[data-phase="partial"]')).toHaveCount(0);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "yield-finished-narrow.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
