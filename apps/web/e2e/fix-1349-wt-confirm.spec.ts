import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * #1349: omp's `/wt` resets and cleans the folder's checkout when "Clean Source Checkout on /wt" is on, and it did so
 * without a question. The app now asks first. Cancel sends nothing, so the uncommitted file stays; Move chat sends the
 * command to omp once, and omp's clean-up runs. Light, dark, and a 390 px phone.
 */

const TRACKED = "README.md";
const LOOSE = "scratch.txt";
const DESKTOP = { width: 1280, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

realTest.use({ seedWorkspace: { files: { [TRACKED]: "# project\n" }, gitRepo: true } });

/** The question the app asks before `/wt`, whose accessible name is "Move to worktree". */
function moveQuestion(page: Page): Locator {
  return page.getByRole("dialog", { name: "Move to worktree" });
}

/** Opens the app in one theme, applied before the first paint. */
function themed(name: "light" | "dark") {
  return {
    beforeLoad: (target: Page) =>
      target.addInitScript(
        (value: string) => window.localStorage.setItem("omp-app.theme", value),
        name,
      ),
  };
}

/** omp's "Clean Source Checkout on /wt" setting, on, in the agent folder's config.yml (the global config). */
async function turnOnCleanSource(agentDir: string): Promise<void> {
  await writeFile(join(agentDir, "config.yml"), "worktree:\n  cleanSource: true\n");
}

/** Commits the seeded files, so the folder is a checkout with commits, as `/wt` needs. */
function commitSeededFiles(folder: string): void {
  execFileSync("git", ["add", "-A"], { cwd: folder });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=omp-app e2e",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "-qm",
      "seed",
    ],
    { cwd: folder },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Starts a chat with one answered message, so the chat has a session file before `/wt` moves it. */
async function startAnsweredChat(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 90_000 });
  return composer;
}

/** Every button of the question sits inside its box and inside the window, so none is pushed off a narrow screen. */
async function expectButtonsOnScreen(page: Page, question: Locator, names: readonly string[]) {
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
  "#1349: /wt asks first; Cancel leaves the uncommitted file in the folder (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    await turnOnCleanSource(realApp.agentDir);
    commitSeededFiles(realApp.folder);
    await writeFile(join(realApp.folder, LOOSE), "not committed\n");

    const page = await realApp.open(themed("light"));
    await page.setViewportSize(DESKTOP);
    const composer = await startAnsweredChat(page);

    await sendTyped(page, composer, "/wt feature");
    const question = moveQuestion(page);
    await expect(question, "/wt asks before omp runs it").toBeVisible({ timeout: 30_000 });
    await expect(question.getByText("Clean Source Checkout on /wt")).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1349-wt-question-light.png") });

    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toHaveCount(0);
    // Cancel sends nothing: omp did not run `/wt`, so the folder keeps its uncommitted file and omp says nothing.
    await expect(page.getByText(/Moved to worktree/)).toHaveCount(0);
    expect(await readFile(join(realApp.folder, LOOSE), "utf8")).toBe("not committed\n");

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await sendTyped(page, composer, "/wt feature");
    await expect(question).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1349-wt-question-dark.png") });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toHaveCount(0);

    await page.setViewportSize(PHONE);
    await sendTyped(page, composer, "/wt feature");
    await expect(question).toBeVisible({ timeout: 30_000 });
    await expectButtonsOnScreen(page, question, ["Cancel", "Move chat"]);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1349-wt-question-phone.png") });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();

    expect(await exists(join(realApp.folder, LOOSE))).toBe(true);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1349: Move chat sends /wt to omp once, and omp's clean-up of the folder runs",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await turnOnCleanSource(realApp.agentDir);
    commitSeededFiles(realApp.folder);
    await writeFile(join(realApp.folder, LOOSE), "not committed\n");

    const page = await realApp.open(themed("light"));
    await page.setViewportSize(DESKTOP);
    const composer = await startAnsweredChat(page);

    await sendTyped(page, composer, "/wt feature");
    const question = moveQuestion(page);
    await expect(question).toBeVisible({ timeout: 30_000 });
    await question.getByRole("button", { name: "Move chat", exact: true }).click();

    // omp's own words for the move, and its clean-up: the uncommitted file is gone from the folder.
    await expect(page.getByText(/Moved to worktree/)).toBeVisible({ timeout: 60_000 });
    expect(await exists(join(realApp.folder, LOOSE))).toBe(false);
    expect(realApp.problems).toEqual([]);
  },
);
