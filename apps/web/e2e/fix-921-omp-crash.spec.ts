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

realTest.setTimeout(300_000);

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function errorBanner(page: Page): Locator {
  return page.locator('[data-slot="u1-thread-error"]');
}

/** A chat with one answered turn, then a second turn that runs a 7 second command, until omp is running it. */
async function chatWithRunningCommand(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "chat before the crash");
  await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await sendPrompt(composer, "Please run slow_tool now.");
  await expect(transcript(page).getByText("sleep 7; echo slow-tool-done").first()).toBeVisible({
    timeout: 90_000,
  });
  return composer;
}

/** Ends the omp the app's server started for the chat the way an out-of-memory kill would. */
function killOmp(pids: readonly number[]): void {
  expect(pids).toHaveLength(1);
  for (const pid of pids) process.kill(pid, "SIGKILL");
}

realTest(
  "after omp is killed while it runs a command, Restart omp brings the same chat back and it goes on",
  async ({ realApp }) => {
    const app = await realApp.open();
    const composer = await chatWithRunningCommand(app);
    const killed = realApp.ompProcesses();

    killOmp(killed);

    const banner = errorBanner(app);
    await expect(banner).toContainText("omp exited (signal SIGKILL)", { timeout: 30_000 });
    // The card of the command that was running says one thing, not that it is cancelled and waiting.
    await expect(transcript(app).getByText("Waiting for bash output…")).toHaveCount(0);
    await expect(transcript(app).getByText("No output was recorded.")).toBeVisible();
    // The chat is saved, so it stays in the list.
    await expect(app.getByText("No sessions in this folder")).toHaveCount(0);
    await app.screenshot({ path: join(screenshots, "fix-921-omp-stopped.png") });
    // The banner in the dark theme and on a phone-sized screen, then back.
    await app.emulateMedia({ colorScheme: "dark" });
    await waitForFiniteAnimations(app);
    await app.screenshot({ path: join(screenshots, "fix-921-omp-stopped-dark.png") });
    await app.emulateMedia({ colorScheme: "light" });
    await app.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(app);
    await expect(banner.getByRole("button", { name: "Restart omp" })).toBeVisible();
    await app.screenshot({ path: join(screenshots, "fix-921-omp-stopped-narrow.png") });
    await app.setViewportSize({ width: 1280, height: 720 });

    await banner.getByRole("button", { name: "Restart omp" }).click();
    await expect(banner).toBeHidden({ timeout: 90_000 });
    const restarted = realApp.ompProcesses();
    expect(restarted).toHaveLength(1);
    expect(restarted).not.toEqual(killed);

    // The same chat: what was said before is still there, and a new message gets an answer.
    await expect(transcript(app).getByText("chat before the crash").first()).toBeVisible();
    await sendPrompt(composer, "ping after the restart");
    await expect(transcript(app).getByText("pong", { exact: true })).toHaveCount(2, {
      timeout: 90_000,
    });
    await expect(app.getByText("The RPC session is not ready")).toHaveCount(0);
    await app.screenshot({ path: join(screenshots, "fix-921-omp-restarted.png") });
  },
);

realTest(
  "the next message after omp was killed starts omp again by itself and is answered",
  async ({ realApp }) => {
    const app = await realApp.open();
    const composer = await chatWithRunningCommand(app);
    killOmp(realApp.ompProcesses());
    await expect(errorBanner(app)).toContainText("omp exited (signal SIGKILL)", {
      timeout: 30_000,
    });

    await sendPrompt(composer, "ping after the crash");

    await expect(transcript(app).getByText("pong", { exact: true })).toHaveCount(2, {
      timeout: 90_000,
    });
    await expect(errorBanner(app)).toBeHidden();
    await expect(app.getByText("The RPC session is not ready")).toHaveCount(0);
    expect(realApp.ompProcesses()).toHaveLength(1);
  },
);

realTest(
  "a chat whose omp is killed during its very first turn is listed, and Restart omp brings it back",
  async ({ realApp }) => {
    const app = await realApp.open();
    const composer = await startChat(app);
    await sendPrompt(composer, "Please run slow_tool now.");
    await expect(transcript(app).getByText("sleep 7; echo slow-tool-done").first()).toBeVisible({
      timeout: 90_000,
    });
    killOmp(realApp.ompProcesses());
    await expect(errorBanner(app)).toContainText("omp exited (signal SIGKILL)", {
      timeout: 30_000,
    });

    // The first turn never finished, but its chat is on disk: the list shows it, not "No sessions".
    const sessions = app.locator('[aria-label="Sessions"]').first();
    await expect(sessions.getByText("Please run slow_tool now.").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(app.getByText("No sessions in this folder")).toHaveCount(0);

    await errorBanner(app).getByRole("button", { name: "Restart omp" }).click();
    await expect(errorBanner(app)).toBeHidden({ timeout: 90_000 });
    await sendPrompt(composer, "ping after the restart");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
  },
);

/** The rows of the transcript, each with its role and its text. */
function transcriptRows(page: Page): Promise<{ role: string | null; text: string }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="u1-message-row"]')).map((row) => ({
      role: row.getAttribute("data-role"),
      text: (row as HTMLElement).innerText,
    })),
  );
}

realTest(
  "an answer cut off by a kill stays under its own question, and the next answer shows only its own text",
  async ({ realApp }) => {
    const app = await realApp.open();
    const composer = await startChat(app);
    await sendPrompt(composer, "chat before the crash");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    // The second answer is a long block of code. omp is killed while it streams.
    await sendPrompt(composer, "stream_long_code please");
    await expect(app.getByRole("button", { name: /Stop generating/ })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      transcript(app)
        .getByText(/Here is the long streamed block/)
        .first(),
    ).toBeVisible({
      timeout: 60_000,
    });
    killOmp(realApp.ompProcesses());
    await expect(errorBanner(app)).toBeVisible({ timeout: 30_000 });
    await errorBanner(app).getByRole("button", { name: "Restart omp" }).click();
    await expect(errorBanner(app)).toBeHidden({ timeout: 90_000 });

    await sendPrompt(composer, "ping after stream kill");
    await expect(app.getByText("Conversation settled")).toBeVisible({ timeout: 90_000 });
    await expect(transcript(app).getByText("pong", { exact: true }).last()).toBeVisible({
      timeout: 90_000,
    });

    // The cut-off text sits above the new question, not in the new answer.
    const rows = await transcriptRows(app);
    const cutOff = rows.findIndex((row) => row.text.includes("Here is the long streamed block"));
    const newQuestion = rows.findIndex((row) => row.text.includes("ping after stream kill"));
    expect(cutOff).toBeGreaterThanOrEqual(0);
    expect(cutOff).toBeLessThan(newQuestion);
    const lastRow = rows.at(-1);
    expect(lastRow?.role).toBe("assistant");
    expect(lastRow?.text).toContain("pong");
    expect(lastRow?.text).not.toContain("long streamed block");

    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-921-cut-off-answer-light.png"),
      fullPage: true,
    });
  },
);
