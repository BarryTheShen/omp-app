import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** The header line that says what omp printed for a command. */
function commandResult(page: Page, text: string): Locator {
  return page.getByRole("status").filter({ hasText: text });
}

/** Every session file omp wrote in this run: a message that reached omp would be in one of them. */
async function sessionFilesText(realApp: RealApp): Promise<string> {
  const sessions = join(realApp.agentDir, "sessions");
  if (!existsSync(sessions)) return "";
  const names = (await readdir(sessions, { recursive: true })).filter((name) =>
    name.endsWith(".jsonl"),
  );
  return (await Promise.all(names.map((name) => readFile(join(sessions, name), "utf8")))).join(
    "\n",
  );
}

/**
 * Types a command, then presses Enter until omp's answer `answer` shows. An Enter pressed while the slash list is loading
 * is dropped for text that is no command, and the list can load again after it first answers, so one Enter is not
 * enough. A dropped Enter sends nothing, and a send that worked clears the composer, so pressing again is safe.
 */
async function typeCommand(
  page: Page,
  composer: Locator,
  text: string,
  answer: Locator,
): Promise<void> {
  await composer.fill(text);
  await expect(page.getByText("No matching commands.")).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await composer.press("Enter");
    await expect(answer).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

realTest(
  "a command typed with a colon reaches omp: /force:read is omp's force command, and the model gets nothing",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await typeCommand(
      page,
      composer,
      "/force:read",
      commandResult(page, "omp: Next turn forced to use read."),
    );
    // omp ran `force` with `read`: its own answer shows in the header, and the text was not sent as a prompt.
    await expect(commandResult(page, "omp: Next turn forced to use read.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(composer).toHaveValue("");
    await expect(page.getByText("pong")).toHaveCount(0);
    expect(await sessionFilesText(realApp)).not.toContain("/force:read");
  },
);

realTest(
  "/fast:on is omp's fast command, and its answer shows in the header without the model",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await typeCommand(page, composer, "/fast:on", commandResult(page, "omp: Fast mode"));
    await expect(commandResult(page, "omp: Fast mode")).toBeVisible({ timeout: 60_000 });
    await expect(composer).toHaveValue("");
    await expect(page.getByText("pong")).toHaveCount(0);
    expect(await sessionFilesText(realApp)).not.toContain("/fast:on");
  },
);

realTest(
  "the colon command's answer reads in dark mode and stays inside a 390 px screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    const composer = await startChat(page);

    await typeCommand(
      page,
      composer,
      "/force:read",
      commandResult(page, "omp: Next turn forced to use read."),
    );
    const answer = commandResult(page, "omp: Next turn forced to use read.");
    await expect(answer).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The answer is painted with the app's own colours, not the browser's default text colour.
    expect(await answer.evaluate((element) => getComputedStyle(element).color)).not.toBe(
      "rgb(0, 0, 0)",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    const box = await answer.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "fix-1273-force-dark-narrow.png"),
      fullPage: true,
    });
  },
);

realTest(
  "a colon form of a terminal-only command is refused like the bare name, and omp never receives it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    // omp reads `/clear:now` as `/clear now`, and `clear` only runs in omp's terminal, so the composer refuses it like `/clear`.
    const refusal = page.locator('[data-composer-error="true"]').filter({
      hasText: "/clear only runs in omp's terminal, so nothing was sent. Use New chat instead.",
    });
    await typeCommand(page, composer, "/clear:now", refusal);
    await expect(composer).toHaveValue("/clear:now");
    await expect(page.getByText("pong")).toHaveCount(0);
    expect(await sessionFilesText(realApp)).not.toContain("/clear:now");
  },
);
