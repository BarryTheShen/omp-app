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
 * Issue 1607, under the one-line rule: the status row is one line at every width. The segments take the room that is left and
 * cut a segment short when it does not fit, and the full text stays in its title and accessible name. The context group keeps its
 * own width and is never clipped, so Usage stays inside the row. The limit is the rendered line-height plus vertical padding and
 * one pixel for fractional layout rounding; a second line exceeds it.
 */
realTest(
  "the status row stays one line at every width, and the context group is never clipped",
  async ({ realApp }) => {
    const page = await realApp.open();
    await startChat(page);
    const status = page.getByRole("contentinfo", { name: "Status" });
    const segments = status.getByRole("region", { name: "Session and workspace status" });
    const context = page.getByRole("region", { name: "Context status" });
    const usage = context.getByRole("button", { name: "Usage" });
    await expect(segments).toBeVisible({ timeout: 30_000 });
    const usageStyle = await usage.evaluate((button) => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        height: rect.height,
        paddingInlineStart: style.paddingInlineStart,
        fontSize: style.fontSize,
        borderWidth: style.borderTopWidth,
      };
    });
    expect(usageStyle).toEqual({
      height: 28,
      paddingInlineStart: "8px",
      fontSize: "12px",
      borderWidth: "0px",
    });
    const oneLineMaxHeight = await segments.evaluate((section) => {
      const style = getComputedStyle(section);
      return (
        Number.parseFloat(style.lineHeight) +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        1
      );
    });
    for (const width of [1920, 1280, 1024, 834, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(usage).toBeVisible();
      // The sidebars slide when the width changes; what a person sees is the layout at rest.
      await waitForFiniteAnimations(page);
      await expect
        .poll(() => segments.evaluate((section) => section.getBoundingClientRect().height), {
          message: `${width} px: the segments take more than one line`,
        })
        .toBeLessThanOrEqual(oneLineMaxHeight);
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
      // The context meter shows only when the status bar is at least 28 rem (448 px) wide (a named container size); its words and Usage stay.
      const statusBar = page.locator('[data-layout-area="statusBar"]');
      const meter = context.getByRole("progressbar");
      await expect
        .poll(
          async () => {
            const barWidth = (await statusBar.boundingBox())?.width ?? 0;
            return (await meter.isVisible()) === barWidth >= 448;
          },
          { message: `${width} px: the context meter does not follow the 448 px rule` },
        )
        .toBe(true);
      await status.screenshot({ path: join(screenshots, `n1-4-status-row-${width}.png`) });
    }
    // At 390 px a segment does not fit: its value is cut short, and its full text is still in its title.
    await expect
      .poll(() =>
        segments.evaluate((section) =>
          [...section.querySelectorAll("[data-segment-value]")].some(
            (value) => value.scrollWidth > value.clientWidth + 1,
          ),
        ),
      )
      .toBe(true);
    await expect(segments.locator('[data-segment="N2.path"]')).toHaveAttribute(
      "title",
      /Workspace folder: /,
    );
    // Below 480 px the folder and the model still show, not only their icons.
    await expect(segments.locator('[data-segment="N2.path"]')).toBeVisible();
    await expect(segments.locator('[data-segment="N2.model"]')).toBeVisible({ timeout: 30_000 });
  },
);
