/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

realTest.setTimeout(240_000);

realTest(
  "real omp: Program Status, Render SVG and Auto-Graph save to omp's config",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("settings-screen");
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    const displayTab = settings
      .getByRole("tablist", { name: "Appearance sections", exact: true })
      .getByRole("tab", { name: "Display", exact: true });
    await displayTab.click();
    const display = page.locator('[data-s1-appearance-section="S1.appearanceDisplay"]');
    await expect(display).toBeVisible();

    const programStatus = display.getByRole("checkbox", { name: "Program Status (OSC 7501)" });
    const renderSvg = display.getByRole("checkbox", { name: "Render SVG Figures" });
    const autoGraph = display.getByRole("combobox", { name: "Auto-Graph Tables" });
    // A box can read unticked for a moment before omp's values load; on a loaded machine that took longer than the
    // default 5 s in one of ten runs.
    // omp's defaults: both booleans on, Auto-Graph "always".
    await expect(programStatus).toBeChecked({ timeout: 30_000 });
    await expect(renderSvg).toBeChecked({ timeout: 30_000 });
    await expect(autoGraph).toHaveValue("always", { timeout: 30_000 });
    await expect(autoGraph.locator("option")).toHaveText(["Smart", "Always", "Off"], {
      timeout: 20_000,
    });
    await programStatus.uncheck();
    await renderSvg.uncheck();
    await autoGraph.selectOption("off");
    const save = display.getByRole("button", { name: "Save changes", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(display.getByText("Applied", { exact: true })).toBeVisible({ timeout: 30_000 });
    const config = await readFile(join(realApp.agentDir, "config.yml"), "utf8");
    expect(config).toMatch(/terminal:\s*\n(?:[ \t]+[^\n]+\n)*[ \t]+programStatus:\s*false/m);
    // The enum writes its string value and the second boolean its own key, under omp's `tui:` group.
    expect(config).toMatch(/tui:\s*\n(?:[ \t]+[^\n]+\n)*[ \t]+renderSvg:\s*false/m);
    expect(config).toMatch(/tui:\s*\n(?:[ \t]+[^\n]+\n)*[ \t]+autoGraph:\s*off/m);

    // The three controls sit in two places of the list, so each theme and width gets one picture of each place.
    const shoot = async (name: string): Promise<void> => {
      const places = [
        ["status", programStatus, "center"],
        ["graph", display.getByText("Render SVG Figures", { exact: true }), "start"],
      ] as const;
      for (const [part, anchor, block] of places) {
        await anchor.evaluate((element, where) => element.scrollIntoView({ block: where }), block);
        await waitForFiniteAnimations(page);
        await page.screenshot({
          path: join(screenshots, `fix-1927-display-${name}-${part}.png`),
          fullPage: true,
        });
      }
    };
    await shoot("light");

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await shoot("dark");

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot("narrow");
    expect(realApp.problems).toEqual([]);
  },
);
