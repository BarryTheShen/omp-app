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

/*
 * Issue 1327: one 100-character word with no spaces in an ask question's text, an option label and an option
 * description pushed the dialog's inner frame wider than the dialog, so Cancel and Review sat outside the dialog and
 * the window. The fake model's `ask_long_word` keyword asks that question. At 1280 px and at 390 px the buttons must
 * sit inside the dialog and the window, and nothing inside the dialog may reach past its right edge. Captured in
 * light, dark and at 390 px.
 */

const QUESTION = /^Answer questions$/;

/** Lets finite transitions settle before a measurement or a screenshot. Bounded, so a stuck transition cannot hang the case. */
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

/** How far the widest element inside the dialog reaches past the dialog's right edge, in CSS pixels (0 when none does). */
async function reachPastDialog(dialog: Locator): Promise<number> {
  return dialog.evaluate((node) => {
    const right = node.getBoundingClientRect().right;
    let past = 0;
    for (const element of node.querySelectorAll("*")) {
      past = Math.max(past, element.getBoundingClientRect().right - right);
    }
    return past;
  });
}

/** Expects the dialog inside the window, each named button inside the dialog, and nothing inside the dialog past its edge. */
async function expectInside(
  page: Page,
  dialog: Locator,
  buttons: readonly string[],
): Promise<void> {
  const viewport = page.viewportSize();
  const box = await dialog.boundingBox();
  if (viewport === null || box === null) throw new Error("The ask dialog has no box to measure.");
  expect(box.x, "the dialog starts inside the window").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "the dialog ends inside the window").toBeLessThanOrEqual(
    viewport.width,
  );
  for (const name of buttons) {
    const button = await dialog.getByRole("button", { name, exact: true }).boundingBox();
    expect(button, `${name} has a box`).not.toBeNull();
    if (button === null) continue;
    expect(button.x, `${name} starts inside the dialog`).toBeGreaterThanOrEqual(box.x);
    expect(button.x + button.width, `${name} ends inside the dialog`).toBeLessThanOrEqual(
      box.x + box.width + 1,
    );
  }
  expect(
    await reachPastDialog(dialog),
    "nothing inside the dialog reaches past its edge",
  ).toBeLessThanOrEqual(1);
}

realTest(
  "#1327: one 100-character word in an ask question keeps Cancel and Review inside the dialog, in light, dark and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please ask_long_word which database to use.");

    const question = page.getByRole("dialog", { name: QUESTION });
    await expect(question).toBeVisible({ timeout: 45_000 });
    await expect(question).toContainText("some_very_long_snake_case_identifier");
    await settle(page);
    await expectInside(page, question, ["Cancel", "Review"]);
    await page.screenshot({ path: join(screenshots, "fix-1327-light.png") });

    await setTheme(page, true);
    await expectInside(page, question, ["Cancel", "Review"]);
    await page.screenshot({ path: join(screenshots, "fix-1327-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(question).toBeVisible();
    await settle(page);
    await expectInside(page, question, ["Cancel", "Review"]);
    await page.screenshot({ path: join(screenshots, "fix-1327-390.png") });

    // The review step: one answer, then Review. Back, Submit and Cancel must stay inside as well.
    await question.getByRole("radio").first().click();
    await question.getByRole("button", { name: "Review", exact: true }).click();
    await expect(question.getByTestId("ask-review")).toBeVisible();
    await expectInside(page, question, ["Back", "Submit", "Cancel"]);
    expect(realApp.problems).toEqual([]);
  },
);
