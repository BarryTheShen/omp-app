import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const appRoot = process.cwd();
const distRoot = join(appRoot, "dist");

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P2/annotations/playground.tsx",
      "--outdir",
      "dist/p2-4-annotations",
      "--target=browser",
    ],
    { cwd: appRoot, stdio: "inherit" },
  );
  const css = readdirSync(join(distRoot, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The P2.4 annotation playground has no stylesheet.");
  mkdirSync(screenshots, { recursive: true });
  writeFileSync(
    join(distRoot, "p2-4-annotations.html"),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><link rel="stylesheet" href="/assets/${css}"/><link rel="icon" href="data:,"/><script type="module" src="/p2-4-annotations/playground.js"></script></head><body><div id="p2-4-annotations-root"></div></body></html>`,
  );
}

realTest(
  "P2.4 annotation editor works with real omp and covers delete, undo and refine",
  async ({ realApp }) => {
    buildPlayground();
    const page = await realApp.open();
    const playgroundUrl = new URL(page.url());
    playgroundUrl.pathname = "/p2-4-annotations.html";
    playgroundUrl.search = "";
    playgroundUrl.hash = "";
    await page.goto(playgroundUrl.toString());
    await expect(page.getByTestId("p2-4-annotations-playground")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Annotation" })).toHaveValue(
      "Check the external API boundary.",
    );
    await page.getByRole("button", { name: "Edit in external editor" }).click();
    await expect(page.getByRole("textbox", { name: "Annotation" })).toHaveValue(
      "Check the external API boundary. (refined)",
    );
    await page.getByRole("button", { name: "Save annotation" }).click();
    await expect(page.getByRole("status")).toHaveText("Annotation saved.");
    await page.getByRole("button", { name: "Delete annotation" }).click();
    await expect(page.getByRole("button", { name: "Undo delete" })).toBeVisible();
    await page.getByRole("button", { name: "Undo delete" }).click();
    await expect(page.getByRole("status")).toHaveText("Annotation saved.");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "p2-4-annotations-light.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.getByTestId("p2-4-annotations-playground")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "p2-4-annotations-dark.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("textbox", { name: "Annotation" })).toBeVisible();
    await expect(
      page.evaluate(() => document.documentElement.scrollWidth),
    ).resolves.toBeLessThanOrEqual(390);
    await page.screenshot({
      path: join(screenshots, "p2-4-annotations-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
