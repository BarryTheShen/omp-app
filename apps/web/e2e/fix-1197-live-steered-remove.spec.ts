import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P6/bar/playground.tsx",
      "--outfile",
      "dist/fix-1197-live-steered-remove.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const stylesheet = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!stylesheet) throw new Error("The production build did not emit the Settings stylesheet.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "fix-1197-live-steered-remove.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${stylesheet}" />
    <title>Queued messages</title>
  </head>
  <body>
    <div id="p6-bar-playground-root"></div>
    <script type="module" src="/fix-1197-live-steered-remove.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(buildPlayground);
async function expectStyledQueueBar(page: Page): Promise<void> {
  const bar = page.getByRole("complementary", { name: "Queued messages" });
  const colors = await bar.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "color-mix(in oklab, var(--muted) 30%, transparent)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
}

test("the live steering preview marks sent text and keeps controls on pending chips", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto("/fix-1197-live-steered-remove.html");
  await expect(page.getByRole("complementary", { name: "Queued messages" })).toBeVisible();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove steering message: Fix the failing test" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove steering message: Steer the next tool" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove follow-up message: Summarize the changes after yield",
    }),
  ).toBeVisible();
  const sentBox = await page.locator('li[data-queue-status="sent"]').boundingBox();
  const pendingBox = await page.locator('li[data-queue-status="queued"]').first().boundingBox();
  expect(sentBox?.height).toBeGreaterThan(0);
  expect(sentBox?.height).toBeCloseTo(pendingBox?.height ?? -1, 0);
  await expectStyledQueueBar(page);
  await page.screenshot({ path: join(SCREENSHOTS, "fix-1197-live-steered-light.png") });

  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.setViewportSize({ width: 1280, height: 844 });
  await dark.goto("/fix-1197-live-steered-remove.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expectStyledQueueBar(dark);
  await dark.screenshot({ path: join(SCREENSHOTS, "fix-1197-live-steered-dark.png") });

  await dark.setViewportSize({ width: 390, height: 844 });
  const dimensions = await dark.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await expectStyledQueueBar(dark);
  await dark.screenshot({ path: join(SCREENSHOTS, "fix-1197-live-steered-390.png") });
});
