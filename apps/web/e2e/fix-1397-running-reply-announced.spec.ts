import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(420_000);

const PROMPT = "stream_held issue-1397";

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function runningRow(page: Page): Locator {
  return sessionList(page).getByRole("option", { name: /New chat/ });
}

/** Two pages share one server and folder. The second must learn about the file-less running chat from the turn event. */
realTest(
  "announces a first running reply to another window before its session file exists",
  async ({ realApp }) => {
    const sender = await realApp.open();
    const observer = await realApp.open();
    await expect(observer.getByText("No sessions in this folder")).toBeVisible();

    const composer = await startChat(sender);
    await sendPrompt(composer, PROMPT);
    await expect(sender.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(runningRow(sender)).toHaveCount(1, { timeout: 30_000 });

    await expect(runningRow(observer)).toHaveCount(1, { timeout: 30_000 });
    await expect(runningRow(observer).getByText("Running")).toBeVisible();

    await writeFile(join(realApp.agentDir, "release-held-reply"), "");
    await expect(sender.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 120_000,
    });
    await expect(
      sessionList(observer).getByRole("option", { name: new RegExp(PROMPT) }),
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(runningRow(observer)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
