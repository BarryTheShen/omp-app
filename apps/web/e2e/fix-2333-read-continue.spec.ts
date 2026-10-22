import { mkdir } from "node:fs/promises";
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

// #2333: a read that stops at its display limit says where it continues: the line after the last one shown.
const LONG_FILE = `${Array.from({ length: 6000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

realTest.use({ seedWorkspace: { files: { "long.txt": LONG_FILE }, gitRepo: false } });

/** Starts a chat at any width: the narrow layout keeps the sessions list in a drawer that must open first. */
async function startChatAt(page: Page, width: number): Promise<Locator> {
  if (width <= 768) {
    const show = page.getByRole("button", { name: "Show sessions sidebar" });
    if ((await show.count()) > 0) await show.first().click();
  }
  const composer = await startChat(page);
  if (width <= 768) {
    const close = page.locator('button[aria-label="Close open sidebar"]');
    if ((await close.count()) > 0) await close.click();
  }
  await waitForFiniteAnimations(page);
  return composer;
}

/** Asks the fake model to read the long file, opens the read card, and returns it. */
async function readLongFile(page: Page, composer: Locator): Promise<Locator> {
  await sendPrompt(composer, "read_long_probe");
  const card = page.getByTestId("t1-read-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await openToolCard(card);
  return card;
}

/** The continue line names the line after the last line the card shows. */
async function expectContinueLine(card: Locator): Promise<void> {
  const continueLine = card.locator('[data-slot="t1-read-continue"]');
  await expect(continueLine).toBeVisible();
  await continueLine.scrollIntoViewIfNeeded();
  const shown = (await card.locator("code").first().textContent()) ?? "";
  const shownLines = shown.split("line ").length - 1;
  await expect(continueLine).toHaveText(`Continue at line ${shownLines + 1}`);
}

realTest(
  "a read that stops at its limit says where it continues, light at 1280 px",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChatAt(page, 1280);
    const card = await readLongFile(page, composer);
    await expectContinueLine(card);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-2333-read-continue-light-1280.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a read that stops at its limit says where it continues, dark at 1280 px",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
      },
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChatAt(page, 1280);
    const card = await readLongFile(page, composer);
    await expectContinueLine(card);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-2333-read-continue-dark-1280.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a read that stops at its limit says where it continues, at 390 px",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChatAt(page, 1280);
    const card = await readLongFile(page, composer);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectContinueLine(card);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-2333-read-continue-narrow-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);
