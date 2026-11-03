import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's background job notices on real omp: a job that finished shows as omp's terminal shows it (one
 * "Background job completed" row with its type, id and how long it ran), not as the text omp hands the model; the
 * row folds out that text.
 */
realTest.describe("new UI background job notices", () => {
  realTest.setTimeout(240_000);

  realTest("a finished background job is one folded row in omp's words", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    // The fake model starts `sleep 2; echo quick-done` in the background; omp delivers its end two seconds later.
    await box.fill("run_quick_background");
    await box.press("Enter");

    const transcript = page.getByRole("region", { name: "Transcript" });
    const row = transcript.getByRole("button", {
      name: /^Background job completed \[bash\] bg_\d+/,
    });
    await expect(row).toBeVisible({ timeout: 120_000 });
    await expect(row).toHaveAttribute("aria-expanded", "false");
    const delivered = page.locator('[data-custom-type="async-result"] pre');
    await expect(delivered).toHaveCount(0);
    // omp's wrapper and its line to the model are never shown.
    await expect(transcript.getByText(/system-notice|Resume your work/)).toHaveCount(0);

    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(delivered).toContainText("quick-done");
    await expect(transcript.getByText(/system-notice|Resume your work/)).toHaveCount(0);

    expect(realApp.problems).toEqual([]);
  });
});
