import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1324. A bash command that exits non-zero: omp's result text ends with two notes to the model,
 * "Wall time: N seconds" and "Command exited with code N". The card's output printed both as if the command
 * had printed them, and "Copy raw output" copied them. Now the output shows only what the command printed; the
 * exit code and the wall time are shown once, as the card's own facts. This is a live run: the fake model asks
 * omp to run a command that does not exist, and real omp runs it.
 */
const PRINTED = "ls: cannot access '/nonexistent-omp-fixture': No such file or directory";

realTest(
  "a failed bash command's output shows only what the command printed; its exit code and wall time appear once, as facts",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "run_failing_bash");

    const card = page.getByTestId("u3-bash-card").first();
    await expect(card.getByTestId("tool-state-chip-error")).toHaveText("Error", {
      timeout: 120_000,
    });
    await openToolCard(card);
    await mkdir(screenshots, { recursive: true });

    // The output block holds only what the command printed: no wall-time line and no exit-code line.
    await expect(card.getByTestId("u3-bash-stdout").locator("pre")).toHaveText(PRINTED);
    // The exit code and the wall time sit once, in the meta row; the banner names the exit code.
    const meta = card.locator('[data-slot="u3-bash-meta"]');
    await expect(meta).toContainText("Exit code: 2");
    await expect(meta).toContainText(/Wall time: \d+ms/);
    await expect(card.locator('[data-slot="u3-tool-card-error"]')).toContainText(
      "Command exited with code 2.",
    );

    // "Copy raw output" copies what the command printed, and says so.
    await card.getByRole("button", { name: "Copy raw output" }).click();
    await expect(card.getByText("Copied raw output", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(PRINTED);

    // Each capture is taken once the app's styles have loaded: the error chip has its surface colour.
    const chip = card.getByTestId("tool-state-chip-error");
    await expect(chip).toHaveCSS("background-color", /^(rgb|oklch)/);
    await card.screenshot({ path: join(screenshots, "fix-1324-failed-bash-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expect(chip).toHaveCSS("background-color", /^(rgb|oklch)/);
    await card.screenshot({ path: join(screenshots, "fix-1324-failed-bash-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await expect(chip).toHaveCSS("background-color", /^(rgb|oklch)/);
    await card.screenshot({ path: join(screenshots, "fix-1324-failed-bash-narrow.png") });
  },
);
