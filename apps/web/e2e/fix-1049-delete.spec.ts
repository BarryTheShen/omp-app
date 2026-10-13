import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, waitForFiniteAnimations } from "./real-omp";

// Three older chats, written the way omp writes them. The list runs newest first: 3, 2, 1.
realTest.use({ seedSessions: 3 });

/** The id real-omp gives the second seeded chat ("Seeded chat 2"); its file name carries it. */
const SEEDED_CHAT_2_ID = "01a00000-0000-7000-8000-000000000001";

/** The chat's row in the Session list: an option whose name starts with its title. */
function chatRow(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(`^${title}`) });
}

/** The chat's Delete item in its More actions menu. */
function deleteItem(page: Page, title: string): Locator {
  return page
    .getByRole("menu", { name: `Actions for ${title}` })
    .getByRole("menuitem", { name: `Delete ${title}` });
}

/** The confirmation dialog: its accessible name is "Delete chat", and its heading names the chat. */
function confirmDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Delete chat" });
}

/** The session files on disk whose name carries `id`, anywhere under omp's sessions folder. */
async function sessionFilesNamed(agentDir: string, id: string): Promise<string[]> {
  const names = await readdir(join(agentDir, "sessions"), { recursive: true });
  return names.filter((name) => String(name).includes(id));
}

/** Lets finite transitions settle before a screenshot. Bounded, so a transition that never ends cannot hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

realTest(
  "#1049: Delete asks first, Cancel keeps the chat, and a second Delete removes its row (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(chatRow(page, "Seeded chat 2")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "More actions for Seeded chat 2" }).click();
    await deleteItem(page, "Seeded chat 2").click();
    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Delete "Seeded chat 2"?');
    await expect(dialog).toContainText("Deleting this chat cannot be undone.");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1049-confirm-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1049-confirm-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1049-confirm-narrow.png") });

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // The narrow layout closed the sidebar. At desktop width it is open again, as on a fresh load (#1179).
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "true");
    await expect(chatRow(page, "Seeded chat 2")).toBeVisible();
    expect(await sessionFilesNamed(realApp.agentDir, SEEDED_CHAT_2_ID)).not.toEqual([]);

    await page.getByRole("button", { name: "More actions for Seeded chat 2" }).click();
    await deleteItem(page, "Seeded chat 2").click();
    await confirmDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(chatRow(page, "Seeded chat 2")).toHaveCount(0, { timeout: 30_000 });
    await expect(chatRow(page, "Seeded chat 1")).toBeVisible();
    await expect(chatRow(page, "Seeded chat 3")).toBeVisible();
    expect(await sessionFilesNamed(realApp.agentDir, SEEDED_CHAT_2_ID)).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1049: deleting the open chat leaves it first, and a prompt in another chat does not write it back",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await expect(chatRow(page, "Seeded chat 2")).toBeVisible({ timeout: 60_000 });

    // Open chat 2, and wait for its composer: the composer exists only for an open chat.
    await chatRow(page, "Seeded chat 2").click();
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
      timeout: 60_000,
    });
    await settle(page);

    await page.getByRole("button", { name: "More actions for Seeded chat 2" }).click();
    await deleteItem(page, "Seeded chat 2").click();
    await confirmDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(chatRow(page, "Seeded chat 2")).toHaveCount(0, { timeout: 30_000 });
    expect(await sessionFilesNamed(realApp.agentDir, SEEDED_CHAT_2_ID)).toEqual([]);

    // A prompt in another chat must not bring the deleted one back, in the list or on disk. The deleted chat's new chat
    // opens after its row goes, so the prompt waits until chat 3 is on screen: a prompt sent before that goes to the chat
    // on screen, which is still the new one.
    await chatRow(page, "Seeded chat 3").click();
    await expect(
      page
        .getByRole("region", { name: "Conversation transcript" })
        .getByText("Seeded chat 3", { exact: true })
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    const composer = page.getByRole("textbox", { name: "Message input" });
    await expect(composer).toBeVisible({ timeout: 60_000 });
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await expect(chatRow(page, "Seeded chat 2")).toHaveCount(0);
    expect(await sessionFilesNamed(realApp.agentDir, SEEDED_CHAT_2_ID)).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);

/** A chat title with no spaces, the way a pasted address reads: a dialog title must wrap it, not widen the dialog. */
const LONG_TITLE = `https://example.com/${"a".repeat(150)}`;

/** Both buttons of the confirmation sit inside the dialog's box and inside the window, so neither can be pushed off. */
async function expectButtonsOnScreen(page: Page): Promise<void> {
  const dialog = await confirmDialog(page).boundingBox();
  const size = page.viewportSize();
  if (dialog === null || size === null) throw new Error("the dialog or the window has no size");
  for (const name of ["Cancel", "Delete"]) {
    const button = await confirmDialog(page)
      .getByRole("button", { name, exact: true })
      .boundingBox();
    if (button === null) throw new Error(`the ${name} button has no box`);
    expect(button.x).toBeGreaterThanOrEqual(dialog.x);
    expect(button.x + button.width).toBeLessThanOrEqual(dialog.x + dialog.width);
    expect(button.y + button.height).toBeLessThanOrEqual(dialog.y + dialog.height);
    expect(button.x + button.width).toBeLessThanOrEqual(size.width);
  }
}

realTest(
  "#1049: a chat title with no spaces wraps in the Delete dialog, and both buttons stay on screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (page) =>
        page.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(chatRow(page, "Seeded chat 1")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "More actions for Seeded chat 1" }).click();
    await page
      .getByRole("menu", { name: "Actions for Seeded chat 1" })
      .getByRole("menuitem", { name: "Rename Seeded chat 1" })
      .click();
    const renameBox = page.getByRole("textbox", { name: "Rename Seeded chat 1" });
    await renameBox.fill(LONG_TITLE);
    await renameBox.press("Enter");
    await expect(chatRow(page, "https://example.com/")).toBeVisible({ timeout: 30_000 });

    // The row is found by its long, space-free prefix, whatever length its stored title has.
    await page
      .getByRole("button", { name: /^More actions for https:\/\/example\.com\/a+/ })
      .click();
    await page
      .getByRole("menu", { name: /^Actions for https:\/\/example\.com\/a+/ })
      .getByRole("menuitem", { name: /^Delete https:\/\/example\.com\/a+/ })
      .click();
    await expect(confirmDialog(page)).toBeVisible();
    await settle(page);
    await expectButtonsOnScreen(page);
    await page.screenshot({ path: join(screenshots, "fix-1049-long-title-light.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(confirmDialog(page)).toBeVisible();
    await settle(page);
    await expectButtonsOnScreen(page);
    await page.screenshot({ path: join(screenshots, "fix-1049-long-title-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1049: a refused delete of a running chat shows its sentence until another chat is opened",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const sentence = "Wait for this chat's turn to finish, then delete it.";
    const page = await realApp.open({
      beforeLoad: (page) =>
        page.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(chatRow(page, "Seeded chat 2")).toBeVisible({ timeout: 60_000 });

    // Open chat 2 and start a turn that runs for seven seconds.
    await chatRow(page, "Seeded chat 2").click();
    const composer = page.getByRole("textbox", { name: "Message input" });
    await expect(composer).toBeVisible({ timeout: 60_000 });
    await sendPrompt(composer, "slow_tool refused");
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });

    // Delete it while the turn runs: the chat is not left, and the sentence shows in the list, in the chat the person is in.
    await page.getByRole("button", { name: "More actions for Seeded chat 2" }).click();
    await deleteItem(page, "Seeded chat 2").click();
    await confirmDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
    const shown = page.getByRole("alert").filter({ hasText: sentence });
    await expect(shown).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1049-refused-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1049-refused-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(shown).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1049-refused-narrow.png") });

    // Opening another chat is the next thing in the list, so the sentence goes.
    await chatRow(page, "Seeded chat 1").click();
    await expect(shown).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
