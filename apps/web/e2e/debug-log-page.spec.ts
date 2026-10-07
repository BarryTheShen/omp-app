import { readFile } from "node:fs/promises";
import { expect, realTest, startChat } from "./real-omp";

/**
 * The page's half of the debug log: what breaks in the browser lands in the same log as the
 * server's own lines, and 'Save debug log' in the command palette downloads it as one file.
 */
realTest(
  "page errors reach the log, and the palette saves the report with them and without the token",
  async ({ realApp }) => {
    realApp.allowProblem(/probe-/);
    const page = await realApp.open();
    const composer = await startChat(page);

    // One of each way a page breaks: an uncaught error, an unhandled rejection, a console error.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("probe-uncaught-error");
      }, 0);
      void Promise.reject(new Error("probe-unhandled-rejection"));
      console.error("probe-console-error", { words: "my private words", more: { nested: true } });
    });
    await expect
      .poll(() => realApp.log(), { timeout: 15_000 })
      .toMatch(/WARN {2}client\.error kind=error message=.*probe-uncaught-error/);
    const log = realApp.log();
    expect(log).toMatch(
      /client\.error kind=unhandledrejection message="Error: probe-unhandled-rejection"/,
    );
    expect(log).toMatch(/client\.error kind=console message="probe-console-error \[Object\]"/);
    // The page's address is logged without its fragment (the launch token) or query.
    expect(log).toMatch(/client\.error .* page=http:\/\/127\.0\.0\.1:\d+\//);
    expect(log).not.toContain(realApp.token);
    expect(log).not.toContain("private words");

    // 'Save debug log' in the palette downloads the same text as one file.
    await composer.focus();
    await page.keyboard.press("Control+k");
    const downloadStarted = page.waitForEvent("download");
    await page.getByRole("option", { name: /Save debug log/ }).click();
    const download = await downloadStarted;
    expect(download.suggestedFilename()).toMatch(/^omp-app-debug-\d{8}-\d{6}\.log$/);
    const path = await download.path();
    const report = await readFile(path, "utf8");
    expect(report).toContain("omp app debug report");
    expect(report).toContain("probe-uncaught-error");
    expect(report).toMatch(/--- omp processes ---/);
    expect(report).not.toContain(realApp.token);
    // The person is told it was saved, in plain words.
    await expect(page.getByText(/Saved omp-app-debug-.*\.log to your downloads/)).toBeVisible();
  },
);
