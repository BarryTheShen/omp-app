import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const NOTICE = "This chat is still running. Deleting it stops the run.";

realTest.setTimeout(240_000);

realTest(
  "a streaming chat offers Delete, stops safely, and closes after deletion",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "slow_tool 90 DELETE-STREAM");
    const runningRow = page.getByRole("option", { name: /^(New chat|slow_tool 90 DELETE-STREAM)/ });
    const more = page.getByRole("button", {
      name: /^More actions for (New chat|slow_tool 90 DELETE-STREAM)$/,
    });
    await expect(runningRow).toBeVisible({ timeout: 60_000 });
    await more.click();
    const menu = page.getByRole("menu").first();
    await expect(menu).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "fix-2106-delete-running-menu-light.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await more.click();
    await expect(menu).toBeVisible();
    await more.click();
    await expect(menu).toBeHidden();
    await more.click();
    await expect(menu).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      path: join(screenshots, "fix-2106-delete-running-menu-dark.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await narrowTo(page);
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await waitForFiniteAnimations(page);
    const narrowMore = page.getByRole("button", {
      name: /^More actions for (New chat|slow_tool 90 DELETE-STREAM)$/,
    });
    await narrowMore.click();
    const narrowMenu = page.getByRole("menu").first();
    await expect(narrowMenu).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "fix-2106-delete-running-menu-390.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();
    await expect(runningRow).toBeVisible({ timeout: 60_000 });
    const desktopMore = page.getByRole("button", {
      name: /^More actions for (New chat|slow_tool 90 DELETE-STREAM)$/,
    });
    await desktopMore.click();
    const deleteItem = page.getByRole("menuitem", {
      name: /^Delete and stop (New chat|slow_tool 90 DELETE-STREAM)$/,
    });
    await expect(deleteItem).toBeVisible({ timeout: 30_000 });
    await deleteItem.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Delete chat" });
    await expect(dialog).toContainText(NOTICE);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(runningRow).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Ready when you are")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2106-delete-running-light.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2106-delete-running-dark.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await narrowTo(page);
    await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2106-delete-running-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "deleting a background-running chat stops that chat while the open chat keeps running",
  async ({ realApp }) => {
    const page = await realApp.open();
    const first = await startChat(page);
    await sendPrompt(first, "slow_tool 900 BACKGROUND-A");
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });
    const second = await startChat(page);
    await sendPrompt(second, "slow_tool 900 OPEN-B");
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });
    // A new chat takes a few seconds to become the open one (about 3 s on the test machine, longer under load); until then the first
    // chat is still the selected row, and the Stop button seen above is the first chat's. The second chat's row is still
    // called "New chat" for a while, so wait on the first chat's row leaving the selection, not on the second one's name.
    await expect(page.getByRole("option", { name: /^slow_tool 900 BACKGROUND-A/ })).toHaveAttribute(
      "aria-selected",
      "false",
      { timeout: 60_000 },
    );

    const backgroundRow = page.getByRole("option", { name: /^slow_tool 900 BACKGROUND-A/ });
    await expect(backgroundRow).toBeVisible({ timeout: 30_000 });
    const backgroundMore = page.getByRole("button", {
      name: "More actions for slow_tool 900 BACKGROUND-A",
    });
    await backgroundMore.click();
    const menu = page.getByRole("menu", { name: "Actions for slow_tool 900 BACKGROUND-A" });
    await expect(menu).toBeVisible();
    await menu
      .getByRole("menuitem", { name: "Delete and stop slow_tool 900 BACKGROUND-A" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Delete chat" });
    await expect(dialog).toContainText(NOTICE);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(backgroundRow).toHaveCount(0, { timeout: 60_000 });

    // The stop for A travels while its row disappears. B must still be running once that stop has had time to land:
    // a stop that reached B instead would show as B's Stop button gone after the wait (B's tool runs for 900 s, so it
    // cannot end by itself, however loaded the machine is).
    const stopB = page.getByRole("button", { name: "Stop generating" });
    await expect(stopB).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(5_000);
    await expect(stopB).toHaveCount(1);
    await stopB.click();
    await expect(stopB).toHaveCount(0, { timeout: 60_000 });
    await page.reload();
    const openRow = page.getByRole("option", { name: /^slow_tool 900 OPEN-B/ });
    await expect(openRow).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
