import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

const REFUSED_WITH_OUTPUT =
  "Running a command without sending its output to the model is not available in this version of omp.";
const PYTHON_UNAVAILABLE = "Python mode is not available in this version of omp.";

realTest(
  "a `!` line runs in bash: its output shows, and the line never reaches the model",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "!echo bash-line-ok");
    await expect(page.getByText("bash-line-ok", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(composer).toHaveValue("");
    // The line did not become a chat message, and the model did not answer it.
    await expect(page.getByText("!echo bash-line-ok", { exact: true })).toHaveCount(0);
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "composer-bash-line-ok.png"), fullPage: true });
  },
);

realTest(
  "a failing `!` line shows the command's error in its output",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "!ls /no-such-dir-command-lines");
    await expect(page.getByText(/No such file or directory/).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(composer).toHaveValue("");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "composer-bash-line-failed.png"),
      fullPage: true,
    });
  },
);

realTest(
  "a `!!` line is refused with its reason, stays in the composer, and nothing runs",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "!!echo excluded-out");
    await expect(page.locator('[data-composer-error="true"]')).toHaveText(REFUSED_WITH_OUTPUT, {
      timeout: 30_000,
    });
    await expect(composer).toHaveValue("!!echo excluded-out");
    await expect(page.getByText("excluded-out", { exact: true })).toHaveCount(0);
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-slot="u1-message-row"]')).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "composer-bang-bang-refused.png"),
      fullPage: true,
    });
  },
);

realTest(
  "a `$` line is refused while Python is unavailable: nothing is sent and the line stays",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "$ echo python-try");
    await expect(page.locator('[data-composer-error="true"]')).toHaveText(PYTHON_UNAVAILABLE, {
      timeout: 30_000,
    });
    await expect(composer).toHaveValue("$ echo python-try");
    // The indicator follows the text: a `$` line selects Python, which is unavailable.
    await expect(page.getByRole("button", { name: "Python" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Prompt" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator('[data-slot="u1-message-row"]')).toHaveCount(0);
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "composer-python-refused.png"),
      fullPage: true,
    });
  },
);
