import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The app's own continue after a usage limit (#2781), on real omp, in the cases that lost a chat's work: a background
 * job's result starts a turn, and the provider refuses that turn with its wait in the error (the fake provider's
 * `usage_limit_after_job`, `retry-after-ms=61000`); and a refusal after a refusal, the job's result refused too with a
 * short wait (`usage_limit_twice`: 61 s, then 5 s). The chat says when it continues and the chat list marks it; a minute
 * after the wait the server runs the turn again by itself, as Retry does. The refusals are plain 400s, so omp's own
 * retry stays out of it and what continues the chat is the app.
 */
realTest.describe("new UI: continuing after a usage limit", () => {
  realTest.setTimeout(330_000);

  realTest(
    "the turn a background job's result started, refused by a usage limit, goes on by itself after the wait",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const list = page.getByRole("navigation", { name: "Chats" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill(`usage_limit_after_job t${Date.now().toString(36)}`);
      await box.press("Enter");
      await expect(page.getByText("background job started")).toBeVisible({ timeout: 60_000 });

      // The job ends after two seconds; the turn its result starts is refused.
      const failure = page.getByRole("alert").filter({ hasText: "The request failed" });
      await expect(failure).toHaveCount(1, { timeout: 60_000 });
      await expect(failure.getByText(/Continues by itself at /)).toBeVisible({ timeout: 30_000 });
      await expect(failure.getByRole("button", { name: "Continue now" })).toBeVisible();
      await expect(failure.getByRole("button", { name: "Don't continue" })).toBeVisible();
      const marked = list.getByRole("button", { name: /continues after its usage limit/ });
      await expect(marked).toHaveCount(1, { timeout: 30_000 });

      // A minute after the provider's wait, the chat goes on by itself.
      await expect(page.getByText("Answered after the usage limit reset.")).toBeVisible({
        timeout: 200_000,
      });
      await expect(page.getByText(/Continues by itself at /)).toHaveCount(0);
      await expect(marked).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a turn refused after a refusal (a job's result, with a short wait) keeps the continue, and the chat goes on by itself",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill(`usage_limit_twice t${Date.now().toString(36)}`);
      await box.press("Enter");

      // The turn that started the job is refused (61 s); four seconds later the job's result starts a turn, refused too
      // (5 s). The continue kept from the first stays, shown on the newest failure.
      const failure = page.getByRole("alert").filter({ hasText: "The request failed" });
      await expect(failure).toHaveCount(2, { timeout: 60_000 });
      await expect(failure.last().getByText(/Continues by itself at /)).toBeVisible({
        timeout: 30_000,
      });

      // A minute after the longer wait, the chat goes on by itself.
      await expect(page.getByText("Answered after the usage limit reset.")).toBeVisible({
        timeout: 200_000,
      });
      await expect(page.getByText(/Continues by itself at /)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a turn refused while a background job runs on (the chat never settles) still goes on by itself after the wait",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill(`usage_limit_job_running t${Date.now().toString(36)}`);
      await box.press("Enter");

      // Two jobs start; the short one's result starts a turn, refused (61 s), while the long one runs on.
      const failure = page.getByRole("alert").filter({ hasText: "The request failed" });
      await expect(failure).toHaveCount(1, { timeout: 60_000 });
      await expect(failure.getByText(/Continues by itself at /)).toBeVisible({ timeout: 30_000 });

      // A minute after the wait the chat goes on by itself, the long job still running.
      await expect(page.getByText("Answered after the usage limit reset.")).toBeVisible({
        timeout: 200_000,
      });
      await expect(page.getByText(/Continues by itself at /)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});
