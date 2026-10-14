import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * The status bar under the composer (N1.4), mounted in the real app on real omp: once a chat is started it shows
 * the Pi mark, the folder, the model omp reports and the local clock; a segment with no value is not drawn
 * (collaboration stays hidden); and the bar is still there, and fits the screen, after a reply and at 390 px.
 * The segment ids are the N2 rows.
 */
realTest(
  "the status bar under the composer shows what the chat and the machine report",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    const bar = page.getByRole("region", { name: "Session and workspace status" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(bar.locator('[data-segment="N2.pi"]')).toBeVisible();
    await expect(bar.locator('[data-segment="N2.path"]')).toContainText(
      realApp.folder.split("/").pop() ?? "",
    );
    await expect(bar.locator('[data-segment="N2.model"]')).toContainText("Fake Model");
    await expect(bar.locator('[data-segment="N2.time"]')).toContainText(/\d{1,2}:\d{2}/);
    await expect(bar.locator('[data-segment="N2.collab"]')).toHaveCount(0);

    await sendPrompt(composer, "Say something short.");
    await expect(page.getByText("Assistant is working…")).toBeHidden({ timeout: 45_000 });
    await expect(bar.locator('[data-segment="N2.model"]')).toContainText("Fake Model");
    await bar.screenshot({ path: join(screenshots, "n1-4-status-in-app.png") });

    await page.setViewportSize({ width: 390, height: 800 });
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(screenshots, "n1-4-status-in-app-390.png") });
  },
);

/**
 * Issue 1607: with the status segments beside it, the context group (Context, its bar, the tokens, Usage) was squeezed to what the
 * segments left and its text was clipped when the main column was about 700 px wide. It now keeps its width and wraps under the
 * segments when it does not fit. The check reads the group's own box: nothing in it may be wider than it is.
 */
realTest(
  "the context group beside the status segments is never clipped, at any width",
  async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    const status = page.getByRole("contentinfo", { name: "Status" });
    const context = page.getByRole("region", { name: "Context status" });
    const usage = context.getByRole("button", { name: "Usage" });
    await expect(status.getByRole("region", { name: "Session and workspace status" })).toBeVisible({
      timeout: 30_000,
    });
    for (const width of [1920, 1280, 1024, 834, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(usage).toBeVisible();
      // The sidebars slide when the width changes; what a person sees is the layout at rest.
      await waitForFiniteAnimations(page);
      await expect
        .poll(() => context.evaluate((group) => group.scrollWidth > group.clientWidth + 1), {
          message: `${width} px: the context group is clipped`,
        })
        .toBe(false);
      await expect
        .poll(
          async () => {
            const [row, button] = await Promise.all([status.boundingBox(), usage.boundingBox()]);
            if (row === null || button === null) return false;
            return button.x >= row.x - 1 && button.x + button.width <= row.x + row.width + 1;
          },
          { message: `${width} px: Usage is not inside the status row` },
        )
        .toBe(true);
      await status.screenshot({ path: join(screenshots, `n1-4-status-row-${width}.png`) });
    }
  },
);
