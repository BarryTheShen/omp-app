import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";
import { sendTyped } from "./share-stub";

/** Shortens how long an unwatched chat's omp process lives, so the test sees it stop (see process-release.spec.ts). */
realTest.use({ idleCloseMs: 1_500 });

/** The session files on disk, anywhere under omp's sessions folder. No folder yet means no session. */
async function sessionFiles(realApp: RealApp): Promise<string[]> {
  try {
    const names = await readdir(join(realApp.agentDir, "sessions"), { recursive: true });
    return names.map(String).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** The chat's row in the session list: an option whose name starts with its title. */
function chatRow(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(`^${title}`) });
}

/** The question the typed `/session delete` asks first: its accessible name is "Delete chat". */
function deleteQuestion(page: Page): Locator {
  return page.getByRole("dialog", { name: "Delete chat" });
}

/**
 * A chat that has answered "ping", so it has a file and a row. Returns its composer, its omp process and the name of its
 * file. Opening a new chat writes that chat's own empty file, so the chat is told apart by its file's name, not by a count.
 */
async function chatWithPing(
  page: Page,
  realApp: RealApp,
): Promise<{ readonly composer: Locator; readonly ompProcess: number; readonly chatFile: string }> {
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toHaveCount(1);
  await expect.poll(() => sessionFiles(realApp), { timeout: 30_000 }).toHaveLength(1);
  const [chatFile] = await sessionFiles(realApp);
  if (chatFile === undefined) throw new Error("the chat has no session file");
  await expect(chatRow(page, "ping")).toBeVisible({ timeout: 30_000 });
  const running = realApp.ompProcesses();
  expect(running).toHaveLength(1);
  const ompProcess = running[0];
  if (ompProcess === undefined) throw new Error("no omp process is running");
  return { composer, ompProcess, chatFile };
}

/** Types `/session delete`, confirms the question, and waits until omp has removed the chat's own file. */
async function deleteTyped(
  page: Page,
  composer: Locator,
  realApp: RealApp,
  chatFile: string,
): Promise<void> {
  await sendTyped(page, composer, "/session delete");
  await deleteQuestion(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => sessionFiles(realApp), { timeout: 30_000 }).not.toContain(chatFile);
}

realTest(
  "#1351: a typed /session delete leaves the open chat and removes its row, the way the sidebar's Delete does",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const { composer, ompProcess, chatFile } = await chatWithPing(page, realApp);

    await deleteTyped(page, composer, realApp, chatFile);

    // The open chat leaves the view for a new chat, and the chat's row goes from the list.
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
    await expect(chatRow(page, "ping")).toHaveCount(0, { timeout: 30_000 });

    // Nothing watches the deleted chat, so its omp stops, and its file does not come back when omp has stopped.
    await expect
      .poll(() => realApp.ompProcesses().includes(ompProcess), { timeout: 30_000 })
      .toBe(false);
    expect(await sessionFiles(realApp)).not.toContain(chatFile);

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1351-session-delete-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1351: the chat leaves in dark mode, and the new chat fits a 390 px screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const { composer, chatFile } = await chatWithPing(page, realApp);

    await deleteTyped(page, composer, realApp, chatFile);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    const box = await composer.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: join(screenshots, "fix-1351-session-delete-dark-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
