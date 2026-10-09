import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page } from "@playwright/test";
import { realTest, screenshots } from "./real-omp";

/**
 * Issues 831, 832 and 833 on the real app (real server, real omp, the fake model) with 12 old chats
 * in the folder, all closed at the start: a chat nobody has open is renamed from its row, and the new
 * title shows at once and after a reload; Enter in the rename box saves without opening another chat;
 * Enter on a row's More actions button still opens its menu; renaming the open chat updates its row.
 * Issue 868: a chat another omp is writing is refused with the plain message and no copy; while a
 * save runs the box is busy; the renamed chat's row has the focus afterwards.
 */
realTest.use({ seedSessions: 12 });

const USER_MESSAGE = '[data-slot="u1-message-row"][data-role="user"]';
/** The seeded chat "Seeded chat 5" (its id is the seeded index, 4, padded). */
const SEEDED_FIVE = "01a00000-0000-7000-8000-000000000004";

/** The sidebar row whose title starts with `title` (a title here never is a prefix of another). */
function rowFor(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(title) });
}

/** Hovers a row, opens its More actions and picks Rename, the way a person does with the mouse. */
async function startRenameFromRow(page: Page, title: string): Promise<Locator> {
  await rowFor(page, title).hover();
  await page.getByRole("button", { name: `More actions for ${title}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${title}` })
    .getByRole("menuitem", { name: `Rename ${title}` })
    .click();
  return page.getByRole("textbox", { name: `Rename ${title}` });
}

/** The sidebar's styles are loaded (a token background, not the browser default) before a capture. */
async function expectStylesLoaded(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
    "href",
    /\/assets\/.+\.css$/,
  );
  const background = await page
    .locator('aside[aria-label="Sessions"]')
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
  "a chat nobody has open is renamed from its row, and the new title stays after a reload",
  async ({ realApp }) => {
    const page = await realApp.open();
    await expect(rowFor(page, "Seeded chat 11")).toBeVisible({ timeout: 30_000 });

    const box = await startRenameFromRow(page, "Seeded chat 11");
    await box.fill("Closed rename probe");
    await box.press("Enter");

    // The row shows the new title at once; nothing waits for a turn to end.
    await expect(rowFor(page, "Closed rename probe")).toBeVisible({ timeout: 45_000 });
    await expect(rowFor(page, "Seeded chat 11")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);

    await page.reload();
    await expect(rowFor(page, "Closed rename probe")).toBeVisible({ timeout: 30_000 });
    await expect(rowFor(page, "Seeded chat 11")).toHaveCount(0);
  },
);

realTest(
  "Enter in the rename box saves the rename and leaves the open chat on screen",
  async ({ realApp }) => {
    const page = await realApp.open();
    await rowFor(page, "Seeded chat 5").click();
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 5" })).toBeVisible({
      timeout: 45_000,
    });

    const box = await startRenameFromRow(page, "Seeded chat 5");
    await box.fill("Enter keeps this chat");
    await box.press("Enter");

    await expect(rowFor(page, "Enter keeps this chat")).toBeVisible({ timeout: 45_000 });
    // Enter did not open the first chat of the list in place of this one.
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 12" })).toHaveCount(0);
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 5" })).toBeVisible();
  },
);

realTest(
  "Enter on a row's More actions button opens its menu, and opens no chat",
  async ({ realApp }) => {
    const page = await realApp.open();
    await expect(rowFor(page, "Seeded chat 6")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "More actions for Seeded chat 6" }).focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("menu", { name: "Actions for Seeded chat 6" })).toBeVisible();
    await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 6" })).toHaveCount(0);
  },
);

realTest("renaming the open chat updates its row at once", async ({ realApp }) => {
  const page = await realApp.open();
  await rowFor(page, "Seeded chat 12").click();
  await expect(page.locator(USER_MESSAGE).filter({ hasText: "Seeded chat 12" })).toBeVisible({
    timeout: 45_000,
  });

  const box = await startRenameFromRow(page, "Seeded chat 12");
  await box.fill("Open rename probe");
  await box.press("Enter");

  await expect(rowFor(page, "Open rename probe")).toBeVisible({ timeout: 5_000 });
  await expect(rowFor(page, "Seeded chat 12")).toHaveCount(0);
});

realTest(
  "a chat another omp is writing is not renamed: the app says why, keeps one row per chat, and renames once that omp is gone",
  async ({ realApp }) => {
    const page = await realApp.open();
    await expect(rowFor(page, "Seeded chat 5")).toBeVisible({ timeout: 30_000 });

    // Another omp takes the chat's lease by writing to it, as an interactive omp does.
    const holder = realApp.startOmp(["--resume", SEEDED_FIVE]);
    expect(await sendCommand(holder, { type: "negotiate_protocol", protocolVersion: 2 })).toBe(
      true,
    );
    expect(
      await sendCommand(holder, { type: "set_session_name", name: "Written by the other omp" }),
    ).toBe(true);

    const box = await startRenameFromRow(page, "Seeded chat 5");
    await box.fill("Refused rename");
    await box.press("Enter");

    await expect(
      page.getByRole("alert").filter({ hasText: "Another omp is using this chat" }),
    ).toBeVisible({ timeout: 60_000 });
    // Nothing was added: still the twelve seeded chats, no copy, and the box keeps what was typed.
    // Each chat has one More actions button, also while its rename box is open (the edited row is not an option then).
    await expect(
      page
        .getByRole("listbox", { name: "Session list" })
        .getByRole("button", { name: /^More actions for / }),
    ).toHaveCount(12);
    await expect(box).toHaveValue("Refused rename");

    // Once the other omp has exited, the same rename goes through.
    const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    holder.kill("SIGTERM");
    await exited;
    await box.press("Enter");
    await expect(rowFor(page, "Refused rename")).toBeVisible({ timeout: 60_000 });
    await page.reload();
    await expect(rowFor(page, "Refused rename")).toBeVisible({ timeout: 30_000 });
    await expect(
      page
        .getByRole("listbox", { name: "Session list" })
        .getByRole("button", { name: /^More actions for / }),
    ).toHaveCount(12);
  },
);

realTest(
  "while a closed chat is renamed the box is busy, and the renamed row has the focus after saving",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await expect(rowFor(page, "Seeded chat 11")).toBeVisible({ timeout: 30_000 });

    const box = await startRenameFromRow(page, "Seeded chat 11");
    await box.fill("Pending rename probe");
    await box.press("Enter");
    await expect(box).toHaveAttribute("aria-busy", "true");
    await expect(box).toHaveAttribute("readonly");
    await expect(page.getByRole("status").filter({ hasText: "Saving…" })).toBeVisible();
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "session-rename-pending-light.png") });

    await expect(rowFor(page, "Pending rename probe")).toBeVisible({ timeout: 60_000 });
    await expect(rowFor(page, "Pending rename probe")).toBeFocused();
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "session-rename-focus-light.png") });
  },
);

realTest(
  "the rename box and the renamed row look right in light, dark and at 390 px",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });

    const light = await realApp.open();
    await expect(rowFor(light, "Seeded chat 11")).toBeVisible({ timeout: 30_000 });
    const lightBox = await startRenameFromRow(light, "Seeded chat 11");
    await lightBox.fill("Light rename probe");
    await expectStylesLoaded(light);
    await light.screenshot({ path: join(screenshots, "session-rename-light-box.png") });
    await lightBox.press("Enter");
    await expect(rowFor(light, "Light rename probe")).toBeVisible({ timeout: 45_000 });
    await expectStylesLoaded(light);
    await light.screenshot({ path: join(screenshots, "session-rename-light-row.png") });

    const dark = await realApp.open();
    await dark.getByRole("radio", { name: "Dark" }).click();
    await expect(dark.locator("html")).toHaveClass(/\bdark\b/);
    await expect(rowFor(dark, "Light rename probe")).toBeVisible({ timeout: 30_000 });
    const darkBox = await startRenameFromRow(dark, "Light rename probe");
    await darkBox.fill("Dark rename probe");
    await expectStylesLoaded(dark);
    await dark.screenshot({ path: join(screenshots, "session-rename-dark-box.png") });
    await darkBox.press("Enter");
    await expect(darkBox).toHaveAttribute("aria-busy", "true");
    await expect(dark.getByRole("status").filter({ hasText: "Saving…" })).toBeVisible();
    await dark.screenshot({ path: join(screenshots, "session-rename-dark-pending.png") });
    await expect(rowFor(dark, "Dark rename probe")).toBeVisible({ timeout: 60_000 });
    await expect(rowFor(dark, "Dark rename probe")).toBeFocused();
    await expectStylesLoaded(dark);
    await dark.screenshot({ path: join(screenshots, "session-rename-dark-focus.png") });
    await dark.getByRole("radio", { name: "System" }).click();

    const narrow = await realApp.open();
    await narrow.setViewportSize({ width: 390, height: 844 });
    await narrow.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(rowFor(narrow, "Dark rename probe")).toBeVisible({ timeout: 30_000 });
    const narrowBox = await startRenameFromRow(narrow, "Dark rename probe");
    await narrowBox.fill("Narrow rename probe");
    await expectStylesLoaded(narrow);
    await narrow.screenshot({ path: join(screenshots, "session-rename-narrow-box.png") });
    await narrowBox.press("Enter");
    await expect(narrowBox).toHaveAttribute("aria-busy", "true");
    await expect(narrow.getByRole("status").filter({ hasText: "Saving…" })).toBeVisible();
    await narrow.screenshot({ path: join(screenshots, "session-rename-narrow-pending.png") });
    await expect(rowFor(narrow, "Narrow rename probe")).toBeVisible({ timeout: 60_000 });
    await expect(rowFor(narrow, "Narrow rename probe")).toBeFocused();
    await expectStylesLoaded(narrow);
    await narrow.screenshot({ path: join(screenshots, "session-rename-narrow-focus.png") });
  },
);
