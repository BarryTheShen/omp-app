import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ElementHandle, Locator, Page } from "@playwright/test";
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
 * Issue #1157. omp asks its questions in one rich dialog (set_ask_dialog, research/modules/U4.md §3.4). A question with
 * one answer shows radio options, a question with several answers shows checkboxes, a prompt with several questions is
 * answered one question at a time, and the chosen answers reach omp, which the ask card shows. Cancelling the dialog
 * stops the turn, as omp's ask tool does. The fake model answers `ask_user` (one radio question), `checkbox_ask_one`
 * (one checkbox question) and `checkbox_ask_two` (a radio question, then a checkbox question), as
 * packages/omp-rpc/scripts/fake-openai-server.ts defines them. Screenshots are light, dark and at 390 px.
 */

realTest.setTimeout(420_000);

/** The rich dialog is named by its heading, not by its kind (#850). */
const DIALOG = /^Answer questions$/;
const SINGLE = "Which database?";
const MULTI = "Which tools should run?";
/** The answer list inside an ask card. */
const CARD = "u4-ask-tool-answers";

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

function askDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: DIALOG });
}

/**
 * Hides the open question and its backdrop, or shows them again, so a capture reads the card behind them. The question
 * is hidden through its element handle, because a hidden dialog cannot be found by its role again. The question itself
 * is in the other captures of this file.
 */
async function setQuestionShown(
  page: Page,
  question: ElementHandle<SVGElement | HTMLElement>,
  shown: boolean,
): Promise<void> {
  await question.evaluate((element, visible) => {
    if (element instanceof HTMLElement) element.style.display = visible ? "" : "none";
  }, shown);
  await page.evaluate((visible) => {
    for (const overlay of document.querySelectorAll<HTMLElement>('[data-slot="dialog-overlay"]')) {
      overlay.style.display = visible ? "" : "none";
    }
  }, shown);
}

/** The chat's ask card, opened so its body shows: a folded card keeps only its one line. */
async function openAskCard(page: Page): Promise<Locator> {
  const card = page.getByTestId(/^tool-card-call_ask/).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await openToolCard(card);
  return card;
}

/**
 * Captures the open dialog in dark and at 390 px, then returns to light at the desktop width. The light capture is
 * taken by the caller first.
 */
async function captureThemesAndNarrow(page: Page, dialog: Locator, name: string): Promise<void> {
  await setTheme(page, true);
  await page.screenshot({ path: join(screenshots, `${name}-dark.png`) });
  await setTheme(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await settle(page);
  await page.screenshot({ path: join(screenshots, `${name}-narrow.png`) });
  await page.setViewportSize({ width: 1280, height: 900 });
}

realTest(
  "a question with one answer shows radio options: arrow keys choose one, Enter goes on, Submit sends it",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please ask_user which database to use.");

    const dialog = askDialog(page);
    await expect(dialog).toContainText(SINGLE, { timeout: 45_000 });
    await expect(dialog.getByText("Choose one option.")).toBeVisible();
    const postgres = dialog.getByRole("radio", { name: /^Postgres/ });
    const sqlite = dialog.getByRole("radio", { name: /^SQLite/ });
    await expect(postgres).toHaveAttribute("aria-checked", "false");
    await expect(sqlite).toHaveAttribute("aria-checked", "false");

    // Down moves to SQLite and chooses it; Up goes back to Postgres.
    await postgres.focus();
    await page.keyboard.press("ArrowDown");
    await expect(sqlite).toBeFocused();
    await expect(sqlite).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowUp");
    await expect(postgres).toHaveAttribute("aria-checked", "true");
    await expect(sqlite).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("ArrowDown");
    await expect(sqlite).toHaveAttribute("aria-checked", "true");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1157-single-light.png") });
    await captureThemesAndNarrow(page, dialog, "fix-1157-single");

    // Enter on Review goes to the review step; Enter on Submit sends the answer.
    await dialog.getByRole("button", { name: "Review", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByTestId("ask-review")).toContainText("SQLite");
    await dialog.getByRole("button", { name: "Submit", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const card = await openAskCard(page);
    await expect(card.getByTestId(CARD)).toContainText(SINGLE, { timeout: 60_000 });
    await expect(card.getByTestId(CARD)).toContainText("SQLite");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a question with several answers shows checkboxes: a click and Space tick them, arrow keys only move focus, Submit sends the set",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please checkbox_ask_one which tools should run.");

    const dialog = askDialog(page);
    await expect(dialog).toContainText(MULTI, { timeout: 45_000 });
    await expect(dialog.getByText("Choose any number of options.")).toBeVisible();
    // The card behind an open question says the app waits for the person's answer. The question and its backdrop are
    // hidden for this capture only, so the card's line reads; the question itself is in the other captures of this file.
    await expect(page.getByText("Waiting for the person's answer").first()).toBeVisible();
    const questionElement = await dialog.elementHandle();
    if (questionElement === null) throw new Error("the open question is not on the page");
    await setQuestionShown(page, questionElement, false);
    await page.screenshot({ path: join(screenshots, "fix-1157-waiting-light.png") });
    await setQuestionShown(page, questionElement, true);
    const read = dialog.getByRole("checkbox", { name: "Read" });
    const grep = dialog.getByRole("checkbox", { name: "Grep" });
    const bash = dialog.getByRole("checkbox", { name: "Bash" });
    await expect(read).toHaveAttribute("aria-checked", "false");

    await read.click();
    await expect(read).toHaveAttribute("aria-checked", "true");
    // Down moves focus to Grep without ticking it; Space ticks it.
    await page.keyboard.press("ArrowDown");
    await expect(grep).toBeFocused();
    await expect(grep).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Space");
    await expect(grep).toHaveAttribute("aria-checked", "true");
    await expect(bash).toHaveAttribute("aria-checked", "false");
    await expect(read).toHaveAttribute("aria-checked", "true");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1157-multi-light.png") });
    await captureThemesAndNarrow(page, dialog, "fix-1157-multi");

    await dialog.getByRole("button", { name: "Review", exact: true }).click();
    await expect(dialog.getByTestId("ask-review")).toContainText("Read, Grep");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const card = await openAskCard(page);
    await expect(card.getByTestId(CARD)).toContainText(MULTI, { timeout: 60_000 });
    await expect(card.getByTestId(CARD)).toContainText("Read, Grep");
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1157-card-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "text typed under Other stays when a box is ticked, and the typed text and the ticked boxes both reach omp",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please checkbox_ask_one which tools should run.");

    const dialog = askDialog(page);
    await expect(dialog).toContainText(MULTI, { timeout: 45_000 });
    await dialog.getByRole("button", { name: "Other", exact: true }).click();
    const other = dialog.getByRole("textbox", { name: "Other answer" });
    await other.fill("Custom tool");
    await dialog.getByRole("checkbox", { name: "Read" }).click();
    await expect(other).toHaveValue("Custom tool");
    await expect(dialog.getByRole("checkbox", { name: "Read" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1157-other-light.png") });

    await dialog.getByRole("button", { name: "Review", exact: true }).click();
    await expect(dialog.getByTestId("ask-review")).toContainText("Read, Custom tool");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const card = await openAskCard(page);
    await expect(card.getByTestId(CARD)).toContainText("Read", { timeout: 60_000 });
    await expect(card.getByTestId(CARD)).toContainText("Custom tool");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a prompt with a question that has one answer and one that has several is answered one question at a time",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "Please checkbox_ask_two which database and tools.");

    const dialog = askDialog(page);
    await expect(dialog).toContainText(SINGLE, { timeout: 45_000 });
    await dialog.getByRole("radio", { name: /^SQLite/ }).click();
    // Next is reached by the keyboard: focus it and press Enter.
    await dialog.getByRole("button", { name: "Next", exact: true }).focus();
    await page.keyboard.press("Enter");

    await expect(dialog).toContainText(MULTI);
    await dialog.getByRole("checkbox", { name: "Read" }).click();
    await dialog.getByRole("checkbox", { name: "Bash" }).click();
    await dialog.getByRole("button", { name: "Review", exact: true }).click();
    await expect(dialog.getByTestId("ask-review")).toContainText("SQLite");
    await expect(dialog.getByTestId("ask-review")).toContainText("Read, Bash");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const card = await openAskCard(page);
    await expect(card.getByTestId(CARD)).toContainText("SQLite", { timeout: 60_000 });
    await expect(card.getByTestId(CARD)).toContainText("Read, Bash");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "cancelling a question with Cancel or Escape stops the turn: the card reads Cancelled and no answer reaches omp",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);

    await sendPrompt(composer, "Please ask_user which database to use.");
    const dialog = askDialog(page);
    await expect(dialog).toContainText(SINGLE, { timeout: 45_000 });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // omp's ask tool ends the turn when the person cancels: the chat says Interrupted, and the card says Cancelled.
    await expect(page.getByText("Interrupted", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /^ask: Cancelled/ })).toHaveCount(1);

    await sendPrompt(composer, "Please checkbox_ask_one which tools should run.");
    await expect(dialog).toContainText(MULTI, { timeout: 45_000 });
    await dialog.getByRole("checkbox", { name: "Read" }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText("Interrupted", { exact: true })).toHaveCount(2, {
      timeout: 60_000,
    });
    await expect(page.getByRole("button", { name: /^ask: Cancelled/ })).toHaveCount(2);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a question with a recommended option marks it Recommended in words, and the dialog is captured in light",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please ask_recommended which database to use.");

    const dialog = askDialog(page);
    await expect(dialog).toContainText(SINGLE, { timeout: 45_000 });
    await expect(dialog.getByRole("radio", { name: /^SQLite/ })).toContainText("Recommended");
    await expect(dialog.getByRole("radio", { name: /^Postgres/ })).not.toContainText("Recommended");
    await page.screenshot({ path: join(screenshots, "fix-1157-recommended-light.png") });

    await dialog.getByRole("radio", { name: /^SQLite/ }).click();
    await dialog.getByRole("button", { name: "Review", exact: true }).click();
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
  },
);

realTest(
  "a checkbox question can be answered with none ticked: Review says None, Submit sends an empty set, and the card says None",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "Please checkbox_ask_one which tools should run.");

    const dialog = askDialog(page);
    await expect(dialog).toContainText(MULTI, { timeout: 45_000 });
    await dialog.getByRole("button", { name: "Review", exact: true }).click();
    await expect(dialog.getByTestId("ask-review")).toContainText("None");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId(/^tool-card-call_ask/).first()).toContainText("None");
  },
);
