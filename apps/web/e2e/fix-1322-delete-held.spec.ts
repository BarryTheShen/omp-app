import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page } from "@playwright/test";
import { realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue 1322 on the real app (real server, real omp, the fake model): a chat another omp has open cannot be deleted.
 * That omp holds the chat's lease by writing to it. The app refuses the delete in plain words and removes nothing, in
 * light, dark and at 390 px; once that omp has exited, the same delete goes through.
 */
realTest.use({ seedSessions: 6 });

/** The seeded chat "Seeded chat 5" (its id is the seeded index, 4, padded). */
const SEEDED_FIVE = "01a00000-0000-7000-8000-000000000004";
const HELD = "Seeded chat 5";
const SENTENCE = "Close this chat before deleting it: omp has it open.";

/** The sidebar row whose title starts with `title` (a title here never is a prefix of another). */
function rowFor(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(title) });
}

/** Focuses a control and presses Enter, the keys a person can use too. */
async function pressButton(locator: Locator): Promise<void> {
  await locator.evaluate((element) => (element as HTMLElement).focus());
  await locator.page().keyboard.press("Enter");
}

/** Deletes a chat from its row: More actions, Delete, then the dialog's Delete button. */
async function deleteFromRow(page: Page, title: string): Promise<void> {
  await pressButton(page.getByRole("button", { name: `More actions for ${title}` }));
  await pressButton(page.getByRole("menuitem", { name: `Delete ${title}` }));
  await pressButton(
    page
      .getByRole("dialog", { name: "Delete chat" })
      .getByRole("button", { name: "Delete", exact: true }),
  );
}

/** The sidebar's styles are loaded (a token background, not the browser default) before a capture. */
async function expectStylesLoaded(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
    "href",
    /\/assets\/.+\.css$/,
  );
  const background = await page
    .locator('aside[aria-label="Session list"]')
    .evaluate((element: HTMLElement) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/**
 * Sends one RPC command to an omp the test started and resolves with whether omp answered success.
 * The app speaks the same newline-delimited JSON protocol.
 */
function sendCommand(child: ChildProcess, command: Record<string, unknown>): Promise<boolean> {
  const id = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const stdout = child.stdout;
  if (!stdout || !child.stdin) return Promise.reject(new Error("The omp has no stdio"));
  const reader = createInterface({ input: stdout });
  const timer = setTimeout(() => {
    reader.close();
    reject(new Error(`omp did not answer ${String(command.type)}`));
  }, 60_000);
  reader.on("line", (line) => {
    const frame: unknown = JSON.parse(line);
    if (typeof frame !== "object" || frame === null || Reflect.get(frame, "id") !== id) return;
    clearTimeout(timer);
    reader.close();
    resolve(Reflect.get(frame, "success") === true);
  });
  child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  return promise;
}

realTest(
  "a chat another omp has open is not deleted: the app says so in plain words, and deletes it once that omp is gone",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });

    // Another omp takes the chat's lease by writing to it, as an interactive omp does.
    const holder = realApp.startOmp(["--resume", SEEDED_FIVE]);
    expect(await sendCommand(holder, { type: "negotiate_protocol", protocolVersion: 2 })).toBe(
      true,
    );
    expect(await sendCommand(holder, { type: "set_session_name", name: HELD })).toBe(true);

    const light = await realApp.open();
    await expect(rowFor(light, HELD)).toBeVisible({ timeout: 30_000 });
    await deleteFromRow(light, HELD);
    await expect(light.getByRole("alert").filter({ hasText: SENTENCE })).toBeVisible({
      timeout: 60_000,
    });
    // Nothing was removed: the chat is still listed.
    await expect(rowFor(light, HELD)).toBeVisible();
    await expectStylesLoaded(light);
    await waitForFiniteAnimations(light);
    await light.screenshot({ path: join(screenshots, "fix-1322-held-light.png"), fullPage: true });

    await light.setViewportSize({ width: 390, height: 844 });
    // At this width the sessions are behind a button, the way a person reaches them.
    await light.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(light.getByRole("alert").filter({ hasText: SENTENCE })).toBeVisible();
    await waitForFiniteAnimations(light);
    await light.screenshot({ path: join(screenshots, "fix-1322-held-390.png"), fullPage: true });

    const dark = await realApp.open({
      beforeLoad: (page) =>
        page.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await expect(rowFor(dark, HELD)).toBeVisible({ timeout: 30_000 });
    await deleteFromRow(dark, HELD);
    await expect(dark.getByRole("alert").filter({ hasText: SENTENCE })).toBeVisible({
      timeout: 60_000,
    });
    await expectStylesLoaded(dark);
    await waitForFiniteAnimations(dark);
    await dark.screenshot({ path: join(screenshots, "fix-1322-held-dark.png"), fullPage: true });

    // Once that omp has exited, the same delete goes through and the chat is gone.
    const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    holder.kill("SIGTERM");
    await exited;
    const after = await realApp.open();
    await expect(rowFor(after, HELD)).toBeVisible({ timeout: 30_000 });
    await deleteFromRow(after, HELD);
    await expect(rowFor(after, HELD)).toHaveCount(0, { timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
