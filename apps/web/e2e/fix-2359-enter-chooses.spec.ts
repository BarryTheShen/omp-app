/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

// #2359: in a select dialog, Enter on the highlighted option chooses it, so an approval takes one step. The approval
// playground runs the real approval flow (ApprovalPortController, then the select dialog).
const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SHOTS = join(APP_ROOT, "../../.data/screenshots");
const PAGE = "/approval-playground.html";
const APPROVE_ONCE = "Approve once";
const APPROVE_SESSION = "Approve for this session";
const DENY = "Deny";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U4/approval/approval-playground.tsx",
      "--outfile",
      "dist/approval-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the approval playground page.",
    );
  writeFileSync(
    join(DIST_ROOT, "approval-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp approval playground</title>
  </head>
  <body>
    <div id="u4-4-playground-root"></div>
    <script type="module" src="/approval-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

/** Opens the approval and waits until its options are on screen and every animation has finished. */
async function openApproval(page: Page): Promise<Locator> {
  await page.locator("#open-approval").click();
  const frame = page.getByTestId("dialog-frame");
  await expect(frame).toBeVisible();
  await expect(frame.getByRole("listbox")).toBeVisible();
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  return frame;
}

/** Saves a full-page screenshot once the page and the highlighted option have styles, not browser defaults. */
async function screenshotStyled(page: Page, name: string, highlighted: Locator): Promise<void> {
  const background = await page
    .locator("main")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  const highlight = await highlighted.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(highlight).not.toBe("rgba(0, 0, 0, 0)");
  // The pointer rests on the page's own button, under a row, so it would shade that row. Move it off, then let the hover fade.
  await page.mouse.move(0, 0);
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

test("one Enter answers an approval with Approve once, light at 1280 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE);
  const frame = await openApproval(page);
  // Approve once is focused and highlighted when the dialog opens, so one Enter chooses it.
  const approve = frame.getByRole("option", { name: APPROVE_ONCE, exact: true });
  await expect(approve).toBeFocused();
  await expect(approve).toHaveAttribute("data-highlighted", "");
  await screenshotStyled(page, "fix-2359-enter-chooses-light-1280", approve);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("last-decision")).toHaveText('{"outcome":"approved"}');
  await expect(frame).toBeHidden();
});

test("one Enter answers an approval with Approve once, dark at 1280 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  const frame = await openApproval(page);
  const approve = frame.getByRole("option", { name: APPROVE_ONCE, exact: true });
  await expect(approve).toBeFocused();
  await expect(approve).toHaveAttribute("data-highlighted", "");
  await screenshotStyled(page, "fix-2359-enter-chooses-dark-1280", approve);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("last-decision")).toHaveText('{"outcome":"approved"}');
  await expect(frame).toBeHidden();
});

test("one Enter answers an approval with Approve once, at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PAGE);
  const frame = await openApproval(page);
  const approve = frame.getByRole("option", { name: APPROVE_ONCE, exact: true });
  await expect(approve).toBeFocused();
  await screenshotStyled(page, "fix-2359-enter-chooses-narrow-390", approve);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("last-decision")).toHaveText('{"outcome":"approved"}');
  await expect(frame).toBeHidden();
});

test("a click only marks an option, and Choose sends it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE);
  const frame = await openApproval(page);
  await frame.getByRole("option", { name: DENY, exact: true }).click();
  await expect(page.getByTestId("last-decision")).toHaveText("No decision yet");
  await frame.getByRole("button", { name: "Choose", exact: true }).click();
  await expect(page.getByTestId("last-decision")).toContainText('"outcome":"denied"');
});

test("an arrow key moves the highlight and focus, and Enter chooses the option it reaches", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE);
  const frame = await openApproval(page);
  await page.keyboard.press("ArrowDown");
  const session = frame.getByRole("option", { name: APPROVE_SESSION, exact: true });
  await expect(session).toBeFocused();
  await expect(session).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("last-decision")).toContainText('"outcome":"denied"');
});
