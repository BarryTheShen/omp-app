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
 * Issue #1618 (gap 3 of #1177). The fake model starts a worker (NestedParent) that starts one nested worker
 * (NestedChild), which waits for a steer. The nested worker's card in the chat has the Agent Hub's cancel control
 * and message box. A steer reaches it and it finishes; a cancel stops it. In both cases its row leaves the
 * Running list of the Agent Hub.
 */
const STEER_TEXT = "steer_probe: wrap up now";
const WIDE = { width: 1280, height: 900 };
const NARROW = { width: 390, height: 844 };

realTest.setTimeout(420_000);

/** Starts the chat's worker tree and returns the nested worker's card, opened, with its messages on screen. */
async function openNestedCard(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "spawn_nested_probe");
  const outer = page.getByTestId("t5-task-card").first();
  await expect(outer).toBeVisible({ timeout: 120_000 });
  await openToolCard(outer);
  const nested = outer.getByTestId("t5-task-card").first();
  await expect(nested).toBeVisible({ timeout: 120_000 });
  await openToolCard(nested);
  return nested;
}

/** The worker's name, as its nested card's Cancel button names it: "Cancel <name>". */
async function workerNameOf(nested: Locator): Promise<string> {
  const cancel = nested.getByRole("button", { name: /^Cancel / });
  await expect(cancel).toBeEnabled({ timeout: 120_000 });
  const name = ((await cancel.getAttribute("aria-label")) ?? "").replace(/^Cancel /, "");
  expect(name).not.toBe("");
  return name;
}

realTest(
  "a nested worker's card steers it: the message reaches the worker, and the worker leaves the Running list",
  async ({ realApp }) => {
    const page = await realApp.open();
    const nested = await openNestedCard(page);
    const worker = await workerNameOf(nested);
    const box = nested.getByRole("textbox", { name: `Message to ${worker}` });
    await expect(nested.getByRole("button", { name: `Send message to ${worker}` })).toBeVisible();
    await expect(box).toBeEnabled({ timeout: 120_000 });
    const controls = nested.locator('[data-slot="p1-nested-controls"]');
    await controls.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await controls.screenshot({ path: join(screenshots, "fix-1618-nested-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await controls.screenshot({ path: join(screenshots, "fix-1618-nested-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize(NARROW);
    await controls.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await controls.screenshot({ path: join(screenshots, "fix-1618-nested-narrow.png") });
    await page.setViewportSize(WIDE);

    await box.fill(STEER_TEXT);
    await box.press("Enter");
    await expect(nested.getByText(STEER_TEXT, { exact: true })).toBeVisible({ timeout: 120_000 });

    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Running.*NestedChild/ })).toHaveCount(0, {
      timeout: 180_000,
    });
    await expect(hub.getByRole("option", { name: /Finished.*NestedChild/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a nested worker's card cancels it: the worker stops, and its row leaves the Running list",
  async ({ realApp }) => {
    const page = await realApp.open();
    const nested = await openNestedCard(page);
    const cancel = nested.getByRole("button", { name: /^Cancel / });
    await expect(cancel).toBeEnabled({ timeout: 120_000 });
    await cancel.click();
    await expect(nested.getByRole("button", { name: /^Cancel / })).toHaveCount(0, {
      timeout: 180_000,
    });

    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Running.*NestedChild/ })).toHaveCount(0, {
      timeout: 180_000,
    });
    await expect(hub.getByRole("option", { name: /Cancelled.*NestedChild/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Escape in a nested card's message box, with nothing typed, leaves the Agent Hub's focused view",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await sendPrompt(composer, "spawn_nested_probe");
    const parent = hub
      .getByRole("option")
      .filter({ has: page.getByText("NestedParent", { exact: true }) })
      .filter({ hasText: "Running" });
    await expect(parent).toHaveCount(1, { timeout: 120_000 });
    await parent.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const focused = page.getByRole("region", { name: /^Transcript of / });
    await expect(focused).toBeVisible({ timeout: 60_000 });
    const nested = focused.getByTestId("t5-task-card").first();
    await expect(nested).toBeVisible({ timeout: 120_000 });
    await openToolCard(nested);
    const worker = await workerNameOf(nested);
    const box = nested.getByRole("textbox", { name: `Message to ${worker}` });
    await expect(box).toBeEnabled({ timeout: 120_000 });
    await box.focus();
    await page.keyboard.press("Escape");
    await expect(hub).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
