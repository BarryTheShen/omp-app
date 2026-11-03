import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A first-run person in the new UI (`apps/ui`): omp has no model and no key, so a new chat's omp stops as it starts.
 * The chat says that no model is set up and where to set one up, never to try again, which would fail the same way.
 */
realTest.use({ noModel: true });

realTest(
  "a new chat with no model says what is missing and where to set it up",
  async ({ realApp }) => {
    realTest.setTimeout(180_000);
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    const notice = page
      .getByRole("main")
      .getByText(/^Could not open this chat: no model is set up yet\./);
    await expect(notice).toBeVisible({ timeout: 90_000 });
    await expect(notice).toContainText(
      "run “omp-app tui”, and choose a model with /model or sign in with /login",
    );
    await expect(page.getByRole("main").getByText(/Try again/)).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "This chat could not be opened",
    );
    expect(realApp.problems).toEqual([]);
  },
);
