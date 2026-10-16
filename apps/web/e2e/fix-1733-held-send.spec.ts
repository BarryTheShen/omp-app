import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page } from "@playwright/test";
import { realTest, screenshots, sendPrompt, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue 1733 on the real app (real server, real omp, the fake model). A tab's delete of a chat that another omp holds is
 * refused, and the refusal leaves the tab with no omp for that chat. Its next message is refused in plain words, and no
 * omp starts on the chat's file. Once that omp has exited, a reload of the page brings the chat back on its own, and the
 * next message reaches omp. The sentence's advice, "Close that omp, then reload this page.", is what this spec follows.
 */
realTest.use({ seedSessions: 6 });

/** The seeded chat "Seeded chat 5" (its id is the seeded index, 4, padded), and the chat opened before it. */
const HELD = "Seeded chat 5";
const SEEDED_FIVE = "01a00000-0000-7000-8000-000000000004";
const DELETE_SENTENCE = "Close this chat before deleting it: omp has it open.";
const REFUSED =
  "Another omp has this chat open, so nothing was sent. Close that omp, then reload this page.";

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
  "a tab whose delete was refused because another omp holds the chat says so when it sends, and the chat answers after its page is reloaded once that omp has gone",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    // Another omp takes the chat's lease by writing to it, as an interactive omp does, before the tab opens the chat.
    const holder = realApp.startOmp(["--resume", SEEDED_FIVE]);
    expect(await sendCommand(holder, { type: "negotiate_protocol", protocolVersion: 2 })).toBe(
      true,
    );
    expect(await sendCommand(holder, { type: "set_session_name", name: HELD })).toBe(true);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = page.getByRole("textbox", { name: "Message input" });

    // The tab opens the chat, so its omp serves it while the other omp holds the chat's lease.
    await rowFor(page, HELD).click();
    await expect(rowFor(page, HELD)).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => realApp.ompProcesses().length, { timeout: 30_000 }).toBe(1);
    // The chat has settled, so omp is idle and its stop is not held back by a turn still starting.
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 60_000 });

    // The tab's own delete: its omp stops, and the refusal leaves the tab with no omp for this chat.
    await deleteFromRow(page, HELD);
    await expect(page.getByRole("alert").filter({ hasText: DELETE_SENTENCE })).toBeVisible({
      timeout: 60_000,
    });
    await expect(rowFor(page, HELD)).toBeVisible();

    // The next message is refused in plain words, nothing is sent, and no omp starts for the chat.
    const running = realApp.ompProcesses();
    await sendPrompt(composer, "hello");
    await expect(page.getByRole("alert").filter({ hasText: REFUSED })).toBeVisible({
      timeout: 60_000,
    });
    expect(realApp.ompProcesses()).toEqual(running);
    await expect(
      page
        .getByRole("region", { name: "Conversation transcript" })
        .getByText("hello", { exact: true }),
    ).toHaveCount(0);

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1733-refused-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1733-refused-dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("alert").filter({ hasText: REFUSED })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1733-refused-390.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    // The other omp exits. Then the page is reloaded, as the sentence says, and the chat answers once it has settled.
    const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    holder.kill("SIGTERM");
    await exited;
    await page.reload();
    await expect(page.locator("[data-app-root='true']")).toBeVisible();
    await expect(rowFor(page, HELD)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 60_000 });

    // The next message reaches omp: the fake model answers "pong".
    await sendPrompt(composer, "again");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
