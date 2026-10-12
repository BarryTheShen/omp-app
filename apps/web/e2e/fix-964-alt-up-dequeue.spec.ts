/// <reference types="node" />
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

/**
 * Alt+Up puts the most recent queued message back in the message box and takes it out of the queue (omp's
 * dequeue key; issue 1195). `run_queued_pair` runs a bash that sleeps 20 seconds, so the turn stays open while
 * messages are queued.
 */

const BASH = "tool-card-call_queued_bash";
const RESTORED = "Brought the last queued message back into the message box.";
const NOTHING_QUEUED = "No queued message to bring back.";
const BOX_HAS_TEXT = "The message box already has text. Clear it, then press Alt+Up again.";

realTest.setTimeout(420_000);

function queueBar(page: Page): Locator {
  return page.getByRole("complementary", { name: "Queued messages" });
}

function lane(page: Page, name: string): Locator {
  return queueBar(page).getByRole("region", { name });
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

/** Sends `run_queued_pair` and waits until the turn is in progress: the composer offers Stop while it runs. */
async function startQueuedRun(page: Page, composer: Locator): Promise<Locator> {
  await sendPrompt(composer, "run_queued_pair");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 120_000,
  });
  return page.getByTestId(BASH);
}

realTest(
  "Alt+Up puts the last queued follow-up back in the box and takes it out of the queue",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await startQueuedRun(page, composer);

    await composer.fill("bring this back");
    await composer.press("Control+Enter");
    await expect(
      lane(page, "After this turn").getByText("bring this back", { exact: true }),
    ).toBeVisible();
    // Captured while the follow-up waits: the lane holds it and the box is empty.
    await settle(page);
    await page.screenshot({ path: join(screenshots, "alt-up-before-light.png"), fullPage: true });

    await composer.press("Alt+ArrowUp");
    await expect(composer).toHaveValue("bring this back");
    await expect(
      lane(page, "After this turn").getByText("bring this back", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(RESTORED)).toBeVisible();

    // Captured after the restore: the text is in the box, the lane no longer holds it, and the notice shows.
    await settle(page);
    await page.screenshot({ path: join(screenshots, "alt-up-after-light.png"), fullPage: true });
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "alt-up-after-narrow.png"),
      fullPage: true,
    });
    if (desktop) await page.setViewportSize(desktop);
  },
);

realTest("the restored message is readable in dark mode", async ({ realApp }) => {
  // The saved theme is set before the page loads, the way a person who chose Dark gets it.
  const page = await realApp.open({
    beforeLoad: (openPage) =>
      openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await startQueuedRun(page, composer);

  await composer.fill("bring this back");
  await composer.press("Control+Enter");
  await expect(
    lane(page, "After this turn").getByText("bring this back", { exact: true }),
  ).toBeVisible();
  await composer.press("Alt+ArrowUp");
  await expect(composer).toHaveValue("bring this back");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await settle(page);
  await page.screenshot({ path: join(screenshots, "alt-up-after-dark.png"), fullPage: true });
});

realTest(
  "with text already in the box, Alt+Up keeps both texts and says to clear the box",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await startQueuedRun(page, composer);

    await composer.fill("queued one");
    await composer.press("Control+Enter");
    await expect(
      lane(page, "After this turn").getByText("queued one", { exact: true }),
    ).toBeVisible();
    await composer.fill("typed now");
    await composer.press("Alt+ArrowUp");

    await expect(page.getByText(BOX_HAS_TEXT)).toBeVisible();
    await expect(composer).toHaveValue("typed now");
    await expect(
      lane(page, "After this turn").getByText("queued one", { exact: true }),
    ).toBeVisible();
  },
);

realTest("with nothing queued, Alt+Up says so and changes nothing", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);

  await composer.press("Alt+ArrowUp");
  await expect(page.getByText(NOTHING_QUEUED)).toBeVisible();
  await expect(composer).toHaveValue("");
});
