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
 * Issue #981. omp exits while the Todo checklist is empty. The chat's banner says so once; the panel keeps its own
 * "Nothing here yet" and does not repeat the chat's failure under it, as if the list itself had failed.
 */
const EXIT_SENTENCE = "omp exited (signal SIGKILL)";

realTest.setTimeout(300_000);

function errorBanner(page: Page): Locator {
  return page.locator('[data-slot="u1-thread-error"]');
}

function todoPanel(page: Page): Locator {
  return page.getByRole("tabpanel", { name: "Todo checklist" });
}

/** A chat that has answered once, so omp is running, and whose Todo checklist is still empty. */
async function answeredChat(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, "chat before the exit");
  await expect(
    page
      .getByRole("region", { name: "Conversation transcript" })
      .getByText("pong", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  // The Panels start closed on a first run (#2570): open them to see the Todo checklist.
  await page.getByRole("button", { name: "Show panels sidebar" }).click();
  await expect(todoPanel(page).getByText("Nothing here yet")).toBeVisible();
}

/** Ends the omp the app's server started for the chat, the way an out-of-memory kill would. */
function killOmp(pids: readonly number[]): void {
  expect(pids).toHaveLength(1);
  for (const pid of pids) process.kill(pid, "SIGKILL");
}

/** The chat's banner says the exit once; the empty panel keeps its own words and does not repeat the exit. */
async function expectExitSaidOnce(page: Page): Promise<void> {
  await expect(errorBanner(page)).toContainText(EXIT_SENTENCE, { timeout: 30_000 });
  await expect(page.getByText(EXIT_SENTENCE)).toHaveCount(1);
  await expect(todoPanel(page).getByText("Nothing here yet")).toBeVisible();
  await expect(todoPanel(page).getByText(EXIT_SENTENCE)).toHaveCount(0);
}

realTest(
  "real omp: after omp exits, the chat says so once and the empty Todo checklist does not repeat it (light)",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await answeredChat(page);
    killOmp(realApp.ompProcesses());
    await expectExitSaidOnce(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-981-todo-light.png"), fullPage: true });
  },
);

realTest(
  "real omp: after omp exits, the empty Todo checklist does not repeat the chat's exit in dark",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await answeredChat(page);
    killOmp(realApp.ompProcesses());
    await expectExitSaidOnce(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-981-todo-dark.png"), fullPage: true });
  },
);

realTest(
  "real omp: at 390 px the empty Todo checklist does not repeat the chat's exit",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await answeredChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    killOmp(realApp.ompProcesses());
    await expectExitSaidOnce(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-981-todo-narrow.png"), fullPage: true });
  },
);
