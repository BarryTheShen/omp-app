import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

async function assertShellUsesBackgroundToken(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
}
async function assertUsageFollowsTool(page: Page): Promise<void> {
  const follows = await page
    .locator('[data-testid^="tool-card-"]')
    .first()
    .evaluate((tool) => {
      const row = document.querySelector('[data-slot="u1-turn-usage"]');
      return (
        row !== null &&
        Boolean(tool.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    });
  expect(follows).toBe(true);
}

realTest(
  "renders one typed turn-usage row after tool results in live and reloaded history",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    const prompt = "Please run_bash and tell me what it printed.";
    await sendPrompt(composer, prompt);
    await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 45_000 });

    const usageRow = page.locator('[data-slot="u1-turn-usage"]');
    await expect(usageRow).toHaveCount(1);
    await expect(usageRow).toContainText("in ");
    await expect(usageRow).toContainText("out ");
    const toolCard = page.locator('[data-testid^="tool-card-"]').first();
    await openToolCard(toolCard);
    await expect(page.getByTestId("u3-bash-stdout")).toContainText("fixture-tool");
    await assertUsageFollowsTool(page);
    const liveRowLabel = await usageRow.getAttribute("aria-label");
    if (liveRowLabel === null) throw new Error("turn usage row has no accessible summary");

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await assertShellUsesBackgroundToken(page);
    await page.screenshot({
      path: join(screenshots, "p7-turn-usage-light.png"),
      fullPage: true,
    });

    await page.reload();
    const historyUsageRow = page.locator('[data-slot="u1-turn-usage"]');
    await expect(historyUsageRow).toHaveCount(1);
    await expect(historyUsageRow).toHaveAttribute("aria-label", liveRowLabel);
    await assertUsageFollowsTool(page);

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await dark.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    const darkRow = dark.locator('[data-slot="u1-turn-usage"]');
    await expect(darkRow).toHaveCount(1);
    await expect(darkRow).toHaveAttribute("aria-label", liveRowLabel);
    await assertShellUsesBackgroundToken(dark);
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "p7-turn-usage-dark.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 844 });
    await expect(darkRow).toBeVisible();
    await waitForFiniteAnimations(dark);
    await assertShellUsesBackgroundToken(dark);
    const usageFits = await darkRow.evaluate((row) => {
      const bounds = row.getBoundingClientRect();
      return (
        bounds.right <= document.documentElement.clientWidth && row.scrollWidth <= row.clientWidth
      );
    });
    expect(usageFits).toBe(true);
    await dark.screenshot({
      path: join(screenshots, "p7-turn-usage-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
