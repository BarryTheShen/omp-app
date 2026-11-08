import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The debug log from the page, on real omp: Save debug log, in the palette and in Settings → App (where a phone finds
 * it), downloads the report `omp-app debug-report` writes; and the page's own errors are written to the app's log.
 */
realTest.describe("new UI debug log", () => {
  realTest.setTimeout(180_000);

  const settings = (page: Page) => page.getByRole("button", { name: "Settings", exact: true });

  /** The file `save` downloads: its name and its text. */
  async function download(
    page: Page,
    save: () => Promise<void>,
  ): Promise<{ readonly name: string; readonly text: string }> {
    const [file] = await Promise.all([page.waitForEvent("download"), save()]);
    return { name: file.suggestedFilename(), text: await readFile(await file.path(), "utf8") };
  }

  realTest(
    "Save debug log in the palette and in Settings → App downloads the app's debug report",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(settings(page).first()).toBeVisible({ timeout: 120_000 });

      const fromPalette = await download(page, async () => {
        await page.keyboard.press("Control+k");
        const search = page
          .getByRole("dialog", { name: "Palette", exact: true })
          .getByRole("combobox", { name: "Search the palette" });
        await search.fill("Save debug log");
        await search.press("Enter");
      });
      expect(fromPalette.name).toMatch(/^omp-app-debug-.+\.log$/);
      expect(fromPalette.text.split("\n")[0]).toBe("omp app debug report");

      await settings(page).first().click();
      const section = page.getByRole("region", { name: "Debug log" });
      const fromSettings = await download(page, () =>
        section.getByRole("button", { name: "Save debug log" }).click(),
      );
      expect(fromSettings.name).toMatch(/^omp-app-debug-.+\.log$/);
      expect(fromSettings.text).toContain("\napp version: ");
      await expect(section.getByRole("status")).toHaveText(
        `Saved ${fromSettings.name} to your downloads. Attach it to an issue.`,
      );
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "on a phone, Settings → App has Save debug log, and it downloads the report",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      await page.getByRole("button", { name: "Chats", exact: true }).tap({ timeout: 120_000 });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Settings" })
        .tap();
      const sheet = page.getByRole("dialog", { name: "Settings" });
      await sheet
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "App", exact: true })
        .tap();
      const save = sheet
        .getByRole("region", { name: "Debug log" })
        .getByRole("button", { name: "Save debug log" });
      await save.scrollIntoViewIfNeeded();
      // A finger's size, as everything tapped outside the chat (#2816).
      expect((await save.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      const saved = await download(page, () => save.tap());
      expect(saved.text.split("\n")[0]).toBe("omp app debug report");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "the page's uncaught errors, unhandled rejections and console errors are written to the app's log, without the link's token",
    async ({ realApp }) => {
      realApp.allowProblem(/zz debug-log probe/);
      const page = await realApp.open({ path: "/" });
      await expect(settings(page).first()).toBeVisible({ timeout: 120_000 });
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error("zz debug-log probe: uncaught");
        }, 0);
        void Promise.reject(new Error("zz debug-log probe: rejected"));
        console.error("zz debug-log probe: console", { words: "private words" });
      });
      const probeLines = (): string[] =>
        realApp
          .log()
          .split("\n")
          .filter((line) => line.includes("client.error") && line.includes("zz debug-log probe"));
      await expect.poll(() => probeLines().length, { timeout: 30_000 }).toBe(3);
      const lines = probeLines();
      expect(lines.find((line) => line.includes("probe: uncaught"))).toContain("kind=error");
      expect(lines.find((line) => line.includes("probe: rejected"))).toContain(
        "kind=unhandledrejection",
      );
      expect(lines.find((line) => line.includes("probe: console"))).toContain("kind=console");
      const written = lines.join("\n");
      expect(written).not.toContain(realApp.token);
      expect(written).not.toContain("private words");
    },
  );
});
