/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const screenshots = resolve(APP_ROOT, "../../.data/screenshots");
const playground = "/u2-modes-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    ["build", "src/modules/U2/modes/playground.tsx", "--outfile", "dist/u2-modes-playground.js", "--target=browser"],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the modes playground.");
  writeFileSync(
    join(DIST_ROOT, "u2-modes-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="/favicon.svg" />
    <title>omp U2.6 modes playground</title>
  </head>
  <body>
    <div id="u2-modes-playground-root"></div>
    <script type="module" src="/u2-modes-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => buildPlaygroundPage());

async function assertStyled(page: Page, dark = false): Promise<void> {
  const styles = await page.getByTestId("u2-modes-playground").evaluate((element) => {
    const shell = element.querySelector<HTMLElement>("[data-composer-surface] > div");
    const body = getComputedStyle(document.body);
    const shellStyles = shell ? getComputedStyle(shell) : null;
    const rgb = body.backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const luminance =
      rgb.length >= 3
        ? (0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0)) / 255
        : 1;
    return {
      font: body.fontFamily,
      background: body.backgroundColor,
      luminance,
      radius: shellStyles?.borderRadius ?? "0px",
    };
  });
  expect(styles.font).not.toBe("Times New Roman");
  expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.radius).not.toBe("0px");
  if (dark) expect(styles.luminance).toBeLessThan(0.5);
}

test("shows bash mode and captures light, dark, and narrow states", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResources: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResources.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(playground);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedResources).toEqual([]);
  await expect(page.getByTestId("u2-modes-playground")).toBeVisible();
  await expect(page.getByText("Python mode is not released")).toBeVisible();
  await page.getByRole("button", { name: "Bash" }).click();
  await expect(page.getByTestId("mode-label")).toHaveText("bash");
  const input = page.getByRole("textbox", { name: "Message input" });
  await input.fill("!ls");
  await assertStyled(page);
  await page.screenshot({ path: join(screenshots, "u2.6-bash-light.png"), fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.context().addInitScript(() => {
    const addDark = () => document.documentElement.classList.add("dark");
    if (document.documentElement) addDark();
    else document.addEventListener("DOMContentLoaded", addDark, { once: true });
  });
  await darkPage.goto(playground);
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await darkPage.getByRole("button", { name: "Bash" }).click();
  await darkPage.getByRole("textbox", { name: "Message input" }).fill("!ls");
  await assertStyled(darkPage, true);
  await darkPage.screenshot({ path: join(screenshots, "u2.6-bash-dark.png"), fullPage: true });

  await darkPage.setViewportSize({ width: 390, height: 844 });
  await assertStyled(darkPage, true);
  await darkPage.screenshot({ path: join(screenshots, "u2.6-bash-narrow.png"), fullPage: true });
});
