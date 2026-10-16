import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const WARNING = "The post-pass freed too little for maintenance to continue.";
const NARROW = { width: 390, height: 844 } as const;

realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Keep the current goal." }],
          timestamp: Date.UTC(2026, 9, 3, 10, 0, 0),
        },
      },
      {
        type: "compaction",
        summary: "Keep the current goal and the parser's invariants.",
        firstKeptEntryId: "e000000",
        tokensBefore: 120_000,
        tokensAfter: 118_000,
        method: "remote",
        warning: WARNING,
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The goal and invariants are preserved." }],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.UTC(2026, 9, 3, 10, 0, 1),
        },
      },
    ],
  },
});

realTest(
  "shows omp's compaction warning in history at desktop and narrow widths",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    const note = page.getByRole("status").filter({ hasText: `Compaction note: ${WARNING}` });
    await expect(note).toBeVisible({ timeout: 60_000 });
    const desktopBackground = await page
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(desktopBackground).not.toBe("rgba(0, 0, 0, 0)");

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "p7-3-compaction-warning-light.png") });

    const darkPage = await realApp.open({
      beforeLoad: (dark) =>
        dark.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await darkPage.setViewportSize({ width: 1280, height: 900 });
    await darkPage
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option")
      .first()
      .click();
    const darkNote = darkPage
      .getByRole("status")
      .filter({ hasText: `Compaction note: ${WARNING}` });
    await expect(darkNote).toBeVisible({ timeout: 60_000 });
    const darkBackground = await darkPage
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(darkBackground).not.toBe("rgba(0, 0, 0, 0)");
    await waitForFiniteAnimations(darkPage);
    await darkPage.screenshot({ path: join(screenshots, "p7-3-compaction-warning-dark.png") });

    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await expect(note).toBeVisible();
    const narrowBackground = await page
      .locator("[data-shell-layout]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(narrowBackground).not.toBe("rgba(0, 0, 0, 0)");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "p7-3-compaction-warning-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
