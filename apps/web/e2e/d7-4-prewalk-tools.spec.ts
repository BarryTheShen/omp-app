/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");
const playground = "/d7-4-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D7/prewalk/playground.tsx",
      "--outfile",
      "dist/d7-4-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The app build did not emit the D7.4 stylesheet.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "d7-4-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <script>
      if (location.search.includes("dark")) document.documentElement.classList.add("dark");
    </script>
    <title>omp preparation and tools</title>
  </head>
  <body>
    <div id="d7-4-playground-root"></div>
    <script type="module" src="/d7-4-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectPageBackground(page: Page): Promise<void> {
  const background = await page.locator("main").evaluate((element) => {
    const token = getComputedStyle(element).getPropertyValue("--background").trim();
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    const actual = getComputedStyle(element).backgroundColor;
    probe.remove();
    return { token, resolved, actual };
  });
  expect(background.token).not.toBe("");
  expect(background.actual).toBe(background.resolved);
}

test.beforeAll(() => buildPlaygroundPage());

test.describe("D7.4 preparation and tools", () => {
  test("runs typed actions, retry and shake confirmation through the fake app client", async ({
    page,
  }) => {
    await page.goto(playground);
    await expect(page.getByRole("region", { name: "Preparation and context" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch model at the next edit" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Drop images from context" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Refresh available tools" })).toBeEnabled();
    await expect(page.getByRole("list", { name: "Tool availability" })).toContainText("Limited");
    await expectPageBackground(page);
    await page.getByRole("button", { name: "Switch model at the next edit" }).click();
    await expect(
      page.getByText("Prewalk on: switching models at the next edit or write."),
    ).toBeVisible();
    await page.screenshot({
      path: join(SCREENSHOTS, "d7.4-prewalk-tools-light.png"),
      fullPage: true,
    });

    const darkPage = await page.context().newPage();
    await darkPage.goto(`${playground}?dark`);
    await expect(darkPage.locator("html")).toHaveClass(/dark/);
    await expectPageBackground(darkPage);
    await darkPage.getByRole("button", { name: "Switch model at the next edit" }).click();
    await expect(
      darkPage.getByText("Prewalk on: switching models at the next edit or write."),
    ).toBeVisible();
    await darkPage.screenshot({
      path: join(SCREENSHOTS, "d7.4-prewalk-tools-dark.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Refresh available tools" }).click();
    await expect(page.getByRole("alert")).toContainText("The tools list could not be refreshed.");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("* bash")).toBeVisible();
    await expect(page.getByText("- browser")).toBeVisible();
    await expect(page.getByText("~ xd://time")).toBeVisible();

    await page.getByRole("button", { name: "Drop images from context" }).click();
    const confirmation = page.getByRole("dialog");
    await expect(confirmation).toContainText("Remove content from this chat?");
    await expect(confirmation).toContainText("omp will remove images from the context it can use.");
    await expect(page.getByText("Waiting for omp to answer.")).toHaveCount(0);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByText("Waiting for omp to answer.")).toHaveCount(0);

    await page.getByRole("button", { name: "Drop images from context" }).click();
    await expect(page.getByRole("dialog")).toContainText("Remove content from this chat?");
    await page.getByRole("button", { name: "Remove content" }).click();
    await expect(
      page.getByText("omp removed the selected content from its conversation context."),
    ).toBeVisible();
  });

  test("fits the controls at 390 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(playground);
    await expect(page.getByRole("region", { name: "Tools and skills" })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    await expectPageBackground(page);
    await page.getByRole("button", { name: "Switch model at the next edit" }).click();
    await expect(
      page.getByText("Prewalk on: switching models at the next edit or write."),
    ).toBeVisible();
    await page.screenshot({
      path: join(SCREENSHOTS, "d7.4-prewalk-tools-390.png"),
      fullPage: true,
    });
  });
});
