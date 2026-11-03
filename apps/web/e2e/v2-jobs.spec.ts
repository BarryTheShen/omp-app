import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's Jobs panel (`apps/ui/src/panels/jobs`) on real omp and the fake model: commands sent to the background
 * (`run_background_job`, `run_quick_background`) are listed with omp's words, a click shows a job's command and output,
 * and Cancel job stops one; a subagent's job (`spawn_long_subagent`) opens the Agent Hub on it.
 */
const panel = (page: Page) => page.getByRole("complementary", { name: "Side panel" });
const railButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Side panel" }).getByRole("button", { name });
const jobs = (page: Page) => panel(page).getByRole("region", { name: "Background jobs" });
const job = (page: Page) => panel(page).getByRole("region", { name: /^Job / });
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

async function newChat(page: Page): Promise<void> {
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
}

async function send(page: Page, text: string): Promise<void> {
  await box(page).fill(text);
  await box(page).press("Enter");
}

realTest.describe("new UI Jobs panel", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a command sent to the background is listed; it opens on its command, and Cancel job stops it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await railButton(page, "Jobs").click();
      await expect(panel(page).getByRole("tabpanel", { name: "Jobs" })).toContainText(
        "Open a chat to see its background jobs.",
      );
      await newChat(page);
      await expect(jobs(page)).toContainText("No background jobs");

      await send(page, "run_background_job");
      const running = jobs(page).getByRole("button", {
        name: /^sleep 120; echo job-0: bash, running, /,
      });
      await expect(running).toBeVisible({ timeout: 90_000 });
      await expect(jobs(page)).toContainText("1 running");
      await running.click();
      await expect(job(page)).toContainText("Running");
      await expect(job(page).getByText("sleep 120; echo job-0", { exact: true })).toBeVisible();
      await expect(job(page)).toContainText("Directory");

      await job(page).getByRole("button", { name: "Cancel job" }).click();
      // omp marks the job cancelled at once; a cancelled job offers no Cancel.
      await expect(job(page)).toContainText("Cancelled", { timeout: 15_000 });
      await expect(job(page).getByRole("button", { name: "Cancel job" })).toHaveCount(0);
      await job(page).getByRole("button", { name: "All jobs" }).click();
      await expect(
        jobs(page).getByRole("button", { name: /^sleep 120; echo job-0: bash, cancelled, / }),
      ).toBeVisible();

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a job that ends shows Done with its exit code and output; a subagent's job opens the Agent Hub",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await railButton(page, "Jobs").click();
      await newChat(page);
      await send(page, "run_quick_background");
      // omp keeps a finished job for 30 s once its result has reached the chat.
      const done = jobs(page).getByRole("button", {
        name: /^sleep 2; echo quick-done: bash, done, /,
      });
      await expect(done).toBeVisible({ timeout: 90_000 });
      await done.click();
      await expect(job(page)).toContainText("Done");
      await expect(job(page)).toContainText("Exit code");
      await expect(job(page)).toContainText("quick-done");
      await job(page).getByRole("button", { name: "All jobs" }).click();

      // The same chat: its subagent runs as a background task job beside the finished command.
      await send(page, "spawn_long_subagent");
      const task = jobs(page).getByRole("button", { name: /: task, running, / });
      await expect(task).toBeVisible({ timeout: 90_000 });
      await task.click();
      await expect(page.getByRole("complementary", { name: "Agent Hub" })).toBeVisible();

      expect(realApp.problems).toEqual([]);
    },
  );
});
