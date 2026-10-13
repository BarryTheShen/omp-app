import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 1169. A worker's transcript opens after omp stops as well as while it runs. When omp kept no file for a worker,
 * the card says so in plain words instead of "could not be read":
 * - a cancelled worker keeps its transcript before and after the app restarts (captured in light, dark and 390 px);
 * - a worker cancelled as soon as it shows opens its transcript, or says omp did not save it;
 * - a worker that finished by yield opens its transcript after the app restarts, once it has completed (the reported case);
 * - a finished worker whose transcript file is gone says omp did not save it, with no Try again (fails on main).
 */

const TRANSCRIPT = '[data-slot="p1-agent-transcript"]';
const NOTICE = '[data-slot="u1-custom-note"]';
const CANCELLED_TEXT = "long_probe_child: run one slow step.";
const NEVER_SAVED = "omp did not save this worker's transcript.";
const COULD_NOT_READ = "The transcript could not be read";

/** The path under `folder` of the one file named `name`, found by walking the folder (omp keeps workers beside the chat). */
async function findFile(folder: string, name: string): Promise<string> {
  const found = (await readdir(folder, { recursive: true })).find(
    (entry) => basename(entry) === name,
  );
  if (found === undefined) throw new Error(`no ${name} under ${folder}`);
  return join(folder, found);
}

realTest.setTimeout(420_000);

realTest(
  "real omp: a cancelled worker's transcript opens before and after the app restarts, and is captured in light, dark and 390 px",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_long_subagent");
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await hub.getByRole("option", { name: /Running.*LongProbe/ }).click();
    const cancel = hub.getByRole("button", { name: /^Cancel / });
    await expect(cancel).toHaveCount(1);
    await cancel.click();
    await expect(hub.getByRole("option", { name: /Cancelled/ })).toHaveCount(1, {
      timeout: 60_000,
    });

    await hub.getByRole("option", { name: /Cancelled/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const region = page.getByRole("region", { name: /^Transcript of / });
    await expect(region.locator(TRANSCRIPT)).toContainText(CANCELLED_TEXT, { timeout: 60_000 });
    await expect(region.getByText(COULD_NOT_READ)).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1169-cancelled-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: join(screenshots, "fix-1169-cancelled-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /show panels sidebar/i }).click();
    await expect(region.locator(TRANSCRIPT)).toContainText(CANCELLED_TEXT, { timeout: 60_000 });
    await page.screenshot({ path: join(screenshots, "fix-1169-cancelled-390.png") });

    // The old tab cannot reach the restarted app: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    await realApp.restartServer();
    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_long_subagent/ })
      .click();
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const reopenedHub = reopened.getByRole("region", { name: "Agent Hub" });
    await reopenedHub.getByRole("option", { name: /Cancelled/ }).click();
    await reopenedHub.getByRole("button", { name: "Open transcript" }).click();
    const reopenedRegion = reopened.getByRole("region", { name: /^Transcript of / });
    await expect(reopenedRegion.locator(TRANSCRIPT)).toContainText(CANCELLED_TEXT, {
      timeout: 60_000,
    });
    await expect(reopenedRegion.getByText(COULD_NOT_READ)).toHaveCount(0);
  },
);

realTest(
  "real omp: a worker cancelled as soon as it shows opens its transcript, or says omp did not save it, and never says it could not be read",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_long_subagent");
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Running.*LongProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await hub.getByRole("option", { name: /Running.*LongProbe/ }).click();
    await hub.getByRole("button", { name: /^Cancel / }).click();
    await expect(hub.getByRole("option", { name: /Cancelled/ })).toHaveCount(1, {
      timeout: 60_000,
    });

    await hub.getByRole("option", { name: /Cancelled/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const region = page.getByRole("region", { name: /^Transcript of / });
    await expect(
      region.getByText(CANCELLED_TEXT).or(region.getByText(NEVER_SAVED)).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(region.getByText(COULD_NOT_READ)).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1169-cancelled-early-light.png") });
  },
);

realTest(
  "real omp: a worker that finished by yield opens its transcript after the app restarts, the reported case",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");
    // The task card reads "Complete" as soon as the spawn returns, while the worker still runs. A restart stops a worker
    // that has not finished, and its file then never gets its end, so wait for the notice that the worker finished.
    await expect(page.locator(NOTICE).filter({ hasText: "NestedProbe finished." })).toBeVisible({
      timeout: 240_000,
    });

    realApp.allowProblem(/WebSocket connection to .* failed/);
    await realApp.restartServer();
    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_subagent/ })
      .click();
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const hub = reopened.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await hub.getByRole("option", { name: /NestedProbe/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const region = reopened.getByRole("region", { name: /^Transcript of NestedProbe/ });
    await expect(region.locator(TRANSCRIPT)).toContainText("nested_probe_child", {
      timeout: 60_000,
    });
    await expect(region.getByText(COULD_NOT_READ)).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await reopened.screenshot({ path: join(screenshots, "fix-1169-finished-restart-light.png") });
  },
);

realTest(
  "real omp: a finished worker whose transcript file is gone says omp did not save it, with no Try again",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");
    await expect(page.locator(NOTICE).filter({ hasText: "NestedProbe finished." })).toBeVisible({
      timeout: 240_000,
    });

    realApp.allowProblem(/WebSocket connection to .* failed/);
    await realApp.restartServer();
    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_subagent/ })
      .click();
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const hub = reopened.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    // The worker's file really is not there: remove it from the chat's folder, then open the transcript.
    await rm(await findFile(realApp.agentDir, "NestedProbe.jsonl"));
    await hub.getByRole("option", { name: /NestedProbe/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const region = reopened.getByRole("region", { name: /^Transcript of NestedProbe/ });
    await expect(region.getByText(NEVER_SAVED)).toBeVisible({ timeout: 60_000 });
    await expect(region.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(region.getByText(COULD_NOT_READ)).toHaveCount(0);
  },
);
