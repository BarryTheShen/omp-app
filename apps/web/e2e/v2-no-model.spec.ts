import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A first-run person in the new UI (`apps/ui`): omp has no model and no key. A new chat still opens, as omp's own
 * terminal does, because signing in runs inside a chat; a message says how to set a model up in the app, and Settings →
 * Providers → Sign-in lists the providers to sign in to. Nothing sends the person to a terminal.
 */
realTest.use({ noModel: true });

realTest(
  "a new chat with no model opens, says how to set one up in the app, and sign-in works from Settings",
  async ({ realApp }) => {
    realTest.setTimeout(180_000);
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 90_000 });
    await box.fill("hello");
    await box.press("Enter");
    const hint = page.getByText(/No model is set up yet\. Sign in to a provider under Settings/);
    await expect(hint).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/omp-app tui/)).toHaveCount(0);
    // The message is not lost: it is back in the box, to send once a model is set up.
    await expect(box).toHaveValue("hello");

    await page.keyboard.press("Control+,");
    await page.getByRole("dialog").getByText("Providers", { exact: true }).first().click();
    await expect(page.getByRole("combobox", { name: "Provider to sign in to" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/omp could not list its providers/)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
