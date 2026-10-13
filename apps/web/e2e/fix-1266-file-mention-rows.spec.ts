import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue 1266: an @file mention in a chat shows one row per file (its path and line count, an image marker, or
 * why its text is not shown), not "Unable to render this omp message.". omp writes the file list for each
 * @path in the prompt; the fake model only answers "pong".
 */

// A 1x1 PNG, so omp reads the file as an image.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

realTest(
  "an @file mention shows its files as rows, not the fallback message (issue 1266)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await writeFile(join(realApp.folder, "notes.txt"), "first line\nsecond line\n");
    await writeFile(join(realApp.folder, "pixel.png"), PIXEL_PNG);
    await writeFile(join(realApp.folder, "data.bin"), Buffer.from([0, 1, 2, 0, 255, 254]));
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "Check @notes.txt @pixel.png @data.bin please");

    const rows = page.locator('[data-u1-row-kind="file-mention"]');
    await expect(rows).toBeVisible({ timeout: 120_000 });
    await expect(rows.getByText("notes.txt", { exact: true })).toBeVisible();
    await expect(rows.getByText("2 lines", { exact: true })).toBeVisible();
    await expect(rows.getByText("pixel.png", { exact: true })).toBeVisible();
    await expect(rows.getByText("Image", { exact: true })).toBeVisible();
    await expect(rows.getByText("data.bin", { exact: true })).toBeVisible();
    await expect(rows.getByText("Skipped: binary file", { exact: true })).toBeVisible();
    await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);

    // The rows sit in omp's system surface, and that surface has its styles: a border and a background.
    const surface = page.locator('[data-message-surface="system-note"]', { has: rows });
    await expect
      .poll(() => surface.evaluate((element) => getComputedStyle(element).borderTopWidth))
      .toBe("1px");
    await expect
      .poll(() => surface.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: join(screenshots, "fix-1266-file-mention-light.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    // Both sidebars close as drawers: wait until each reports closed, then for the fade to end.
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await waitForFiniteAnimations(page);
    await expect(rows).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1266-file-mention-narrow.png") });

    await page.setViewportSize({ width: 1280, height: 800 });
    // Both sidebars open again: wait until each reports open, then for the fade to end.
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "true");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute("data-open", "true");
    await waitForFiniteAnimations(page);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expect
      .poll(() => surface.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: join(screenshots, "fix-1266-file-mention-dark.png") });

    // The same rows come back from omp's saved session after a reload, not only from the live stream.
    await page.reload();
    await expect(rows.getByText("notes.txt", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(rows.getByText("2 lines", { exact: true })).toBeVisible();
    await expect(rows.getByText("Skipped: binary file", { exact: true })).toBeVisible();
    await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);
  },
);
