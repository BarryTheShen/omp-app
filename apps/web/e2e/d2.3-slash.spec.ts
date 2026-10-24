import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** The list of omp's commands above the composer (its listbox). */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** The painted surface inside the list: the element that carries the popover's background and border. */
function commandSurface(page: Page): Locator {
  return commandList(page).locator("div.bg-popover").first();
}

/** The surface's box, read in the same poll that finds one: a box read after a separate wait can be gone by then. */
async function drawnSurfaceBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const drawn = Promise.withResolvers<{ x: number; y: number; width: number; height: number }>();
  await expect
    .poll(async () => {
      const box = await commandSurface(page).boundingBox();
      if (box !== null) drawn.resolve(box);
      return box !== null;
    })
    .toBe(true);
  return drawn.promise;
}

/** The command output panel: every line of what a command printed, kept until the person closes it. */
function commandResult(page: Page): Locator {
  return page.getByRole("region", { name: "Command output" });
}

realTest(
  "typing / lists omp's own commands; Enter inserts one that takes arguments, and Enter again runs it without the model",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await composer.fill("/usage");
    await expect(commandList(page)).toBeVisible({ timeout: 30_000 });
    const usage = commandList(page).getByRole("option", { name: /^\/usage/ });
    // The list shows "Loading commands" until omp answers. A real omp's first answer can take longer than the default
    // 5 s under load, so this row waits with the same bound as the list above (issue 2245, item d2.3:43).
    await expect(usage).toContainText("Built-in", { timeout: 30_000 });
    await expect(usage).toContainText("Show token usage");
    await expect(usage).toContainText("Arguments: [show|reset");

    // /usage takes arguments, so Enter on it inserts it with one trailing space; a command with none runs at once (next test).
    await composer.press("Enter");
    await expect(composer).toHaveValue("/usage ");
    // Its subcommands are offered next; Escape closes them and the message is unchanged.
    await expect(commandList(page).getByRole("option", { name: /^\/usage show/ })).toBeVisible({
      timeout: 30_000,
    });
    await composer.press("Escape");
    await expect(commandList(page)).toBeHidden();
    await expect(composer).toHaveValue("/usage ");

    // Enter now sends. omp runs /usage itself: its printed totals show, and the model never answers.
    await composer.press("Enter");
    await expect(commandResult(page)).toContainText("Input tokens: 0", { timeout: 60_000 });
    await expect(composer).toHaveValue("");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
  },
);

realTest(
  "a command with no arguments runs when Enter chooses it, and the answer shows without the model",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    // /context takes no arguments, so the one Enter that chooses it also sends it.
    await composer.fill("/context");
    await expect(commandList(page).getByRole("option", { name: /^\/context/ })).toBeVisible({
      timeout: 30_000,
    });
    await composer.press("Enter");
    // The composer empties: the one Enter sent /context, and the list closed.
    await expect(page.locator('textarea[aria-label="Message input"]')).toHaveValue("", {
      timeout: 60_000,
    });
    await expect(commandList(page)).toBeHidden();
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
  },
);

realTest(
  "text that is not a known command still goes to the model",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    // A path, an unknown word and a message that starts with a space are plain prompts. Each is sent once the box is empty
    // again, and answered before the next one is typed. A line that starts with "/" waits for the command search before Enter
    // sends it, so under a slow page the box can take well past the default 5 s: each wait gets 60 s. "Conversation settled"
    // from the previous answer is still on screen, so it cannot tell the turns apart; the count of answers can.
    for (const [index, text] of ["/etc/hosts", "/nosuchcommand", " /usage"].entries()) {
      await sendPrompt(composer, text);
      await expect(composer).toHaveValue("", { timeout: 60_000 });
      await expect(page.getByText("pong", { exact: true })).toHaveCount(index + 1, {
        timeout: 60_000,
      });
      await expect(composer).toBeEnabled({ timeout: 60_000 });
    }
    await expect(commandResult(page)).toHaveCount(0);
  },
);

realTest("the command list reads in light mode", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  const composer = await startChat(page);
  await composer.fill("/usage");
  await expect(commandList(page)).toBeVisible({ timeout: 30_000 });
  // The list draws with the app's own surface, not the browser's default: a transparent background would mean no styles loaded.
  expect(
    await commandSurface(page).evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "d2.3-slash-light.png"), fullPage: true });
});

realTest("the command list reads in dark mode", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
  await page.reload();
  const composer = await startChat(page);
  await composer.fill("/usage");
  await expect(commandList(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(
    await commandSurface(page).evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "d2.3-slash-dark.png"), fullPage: true });
});

realTest(
  "the command list stays inside the screen at 200% zoom (640 px) and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("/usage");
    await expect(commandList(page)).toBeVisible({ timeout: 30_000 });
    for (const width of [640, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // The surface is shown first, then its box is read in the poll that finds one: boundingBox() does not wait, and the
      // surface can be drawn again a moment after a resize.
      await expect(commandSurface(page)).toBeVisible();
      const box = await drawnSurfaceBox(page);
      expect(box.x, `${width} px left edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${width} px right edge`).toBeLessThanOrEqual(width);
      await waitForFiniteAnimations(page);
    }
    await page.screenshot({ path: join(screenshots, "d2.3-slash-narrow.png"), fullPage: true });
  },
);
