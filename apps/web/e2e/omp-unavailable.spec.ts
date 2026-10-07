import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Issue #703. With omp missing, the page used to show the normal app ("Ready when you are") and
 * 'New chat' failed without a word, plus an unhandled error. It now shows one screen that says
 * omp isn't available, why, and what to do. The server is the real app server pointed at a path
 * where there is no omp.
 */
realTest.use({ ompBinary: "/nonexistent/omp" });

realTest(
  "with no omp to run, the page says omp isn't available instead of showing an app that fails silently",
  async ({ realApp }) => {
    // The server reports this and the page shows it; the log holds the reason too.
    const page = await realApp.open({ expectApp: false });
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByRole("heading", { name: "omp isn't available" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("omp was not found.")).toBeVisible();
    await expect(page.getByText(/omp --version/).first()).toBeVisible();
    // No app behind it: nothing to click that would fail silently.
    await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
    await expect(page.getByLabel("Message input")).toHaveCount(0);
    // And where to look, with the log path the server reported.
    await expect(page.locator("[data-log-hint='true']")).toContainText("omp-app debug-report");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "omp-unavailable.png") });

    expect(realApp.log()).toMatch(/omp\.probe status=unhealthy .*detail="omp was not found\."/);
  },
);
