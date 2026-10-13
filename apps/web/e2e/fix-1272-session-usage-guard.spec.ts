import { mkdir, readdir } from "node:fs/promises";
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
import { sendTyped } from "./share-stub";

/** The session files on disk, anywhere under omp's sessions folder. No folder yet means no session. */
async function sessionFiles(agentDir: string): Promise<string[]> {
  try {
    const names = await readdir(join(agentDir, "sessions"), { recursive: true });
    return names.map(String).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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

/** The question the app asks before `/session delete`: the chat's own delete question, whose accessible name is "Delete chat". */
function deleteQuestion(page: Page): Locator {
  return page.getByRole("dialog", { name: "Delete chat" });
}

/** The question the app asks before `/usage reset` spends a saved reset, whose accessible name is "Reset usage". */
function resetQuestion(page: Page): Locator {
  return page.getByRole("dialog", { name: "Reset usage" });
}

/** Every button of a question sits inside its box and inside the window, so none can be pushed off a narrow screen. */
async function expectButtonsOnScreen(
  page: Page,
  question: Locator,
  names: readonly string[],
): Promise<void> {
  const box = await question.boundingBox();
  const size = page.viewportSize();
  if (box === null || size === null) throw new Error("the question or the window has no size");
  for (const name of names) {
    const button = await question.getByRole("button", { name, exact: true }).boundingBox();
    if (button === null) throw new Error(`the ${name} button has no box`);
    expect(button.x).toBeGreaterThanOrEqual(box.x);
    expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
    expect(button.y + button.height).toBeLessThanOrEqual(box.y + box.height);
    expect(button.x + button.width).toBeLessThanOrEqual(size.width);
  }
}

realTest(
  "#1272: /session delete asks first; Cancel keeps the session file, and Delete removes it (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    // A chat has a session file once omp has answered its first message.
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(1);
    await expect.poll(() => sessionFiles(realApp.agentDir), { timeout: 30_000 }).toHaveLength(1);

    await sendTyped(page, composer, "/session delete");
    const question = deleteQuestion(page);
    await expect(question).toBeVisible();
    await expect(question).toContainText('Delete "ping"?');
    await expect(question).toContainText("Deleting this chat cannot be undone.");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1272-session-delete-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1272-session-delete-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(question).toBeVisible();
    await settle(page);
    await expectButtonsOnScreen(page, question, ["Cancel", "Delete"]);
    await page.screenshot({ path: join(screenshots, "fix-1272-session-delete-narrow.png") });

    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toHaveCount(0);
    // Cancel sends nothing. A prompt sent after it is answered by omp in the same session, so once that answer shows,
    // any delete sent before it has been processed, and the file must still be there.
    await page.setViewportSize({ width: 1280, height: 800 });
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2);
    expect(await sessionFiles(realApp.agentDir)).toHaveLength(1);
    await expect(page.getByText(/Session deleted:/)).toHaveCount(0);

    await sendTyped(page, composer, "/session delete");
    await expect(deleteQuestion(page)).toBeVisible();
    await deleteQuestion(page).getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText(/Session deleted:/)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sessionFiles(realApp.agentDir), { timeout: 30_000 }).toHaveLength(0);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1272-session-delete-after.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1272: /usage reset names the account and says one reset is spent; Cancel sends nothing, Spend reset sends it once (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendTyped(page, composer, "/usage reset codex/active");
    const question = resetQuestion(page);
    await expect(question).toBeVisible();
    await expect(question).toContainText("Spend a saved reset on Codex, the active account?");
    await expect(question).toContainText(
      "This spends one saved reset. A spent reset cannot be undone.",
    );
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1272-usage-reset-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1272-usage-reset-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(question).toBeVisible();
    await settle(page);
    await expectButtonsOnScreen(page, question, ["Cancel", "Spend reset"]);
    await page.screenshot({ path: join(screenshots, "fix-1272-usage-reset-narrow.png") });

    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toHaveCount(0);
    // Cancel sends nothing: a prompt sent after it is answered, and no reset status appears after that answer.
    await page.setViewportSize({ width: 1280, height: 800 });
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/No provider accounts found/)).toHaveCount(0);

    await sendTyped(page, composer, "/usage reset codex/active");
    await expect(resetQuestion(page)).toBeVisible();
    await resetQuestion(page).getByRole("button", { name: "Spend reset", exact: true }).click();
    await expect(
      page.getByText("omp: No provider accounts found. Use /login to add one.", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1272-usage-reset-after.png") });
    // A plain prompt is still omp's: the guard answers only the forms it names.
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2);
    expect(realApp.problems).toEqual([]);
  },
);
