/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS_ROOT = join(APP_ROOT, "../../.data/screenshots");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P4/selector/playground.tsx",
      "--outfile",
      "dist/p4-tree-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit the P4 tree stylesheet.");
  mkdirSync(SCREENSHOTS_ROOT, { recursive: true });
  const playgroundPage = (dark = false): string => `<!doctype html>
<html lang="en"${dark ? ' class="dark"' : ""}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Conversation history</title>
  </head>
  <body>
    <div id="p4-tree-playground-root"></div>
    <script type="module" src="/p4-tree-playground.js"></script>
  </body>
</html>
`;
  writeFileSync(join(DIST_ROOT, "p4-tree-playground.html"), playgroundPage());
  writeFileSync(join(DIST_ROOT, "p4-tree-playground-dark.html"), playgroundPage(true));
}

async function expectSidebarTokenStyles(page: Page): Promise<void> {
  const panel = page.getByRole("region", { name: "Conversation history" });
  await expect(panel).toBeVisible();
  const styleEvidence = await panel.evaluate((element) => {
    const panelBackground = getComputedStyle(element).backgroundColor;
    const sidebarToken = getComputedStyle(document.documentElement)
      .getPropertyValue("--sidebar")
      .trim();
    const tokenProbe = document.createElement("span");
    tokenProbe.style.backgroundColor = "var(--sidebar)";
    document.body.appendChild(tokenProbe);
    const tokenBackground = getComputedStyle(tokenProbe).backgroundColor;
    tokenProbe.remove();
    return { panelBackground, sidebarToken, tokenBackground };
  });
  expect(styleEvidence.panelBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(styleEvidence.panelBackground).toBe(styleEvidence.tokenBackground);
  expect(styleEvidence.sidebarToken).not.toBe("");
}

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildPlaygroundPage();
  }),
);

test("captures the token-styled conversation history in light mode", async ({ page }) => {
  await page.goto("/p4-tree-playground.html");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByRole("treeitem", { name: /Review checkpoint/ })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /, current message/ })).toBeVisible();
  await expectSidebarTokenStyles(page);
  // omp writes a straight chain: no message is indented below another.
  const indents = await page
    .getByRole("treeitem")
    .evaluateAll((items) =>
      items.map((item) => Number.parseFloat(getComputedStyle(item).paddingInlineStart) || 0),
    );
  expect(Math.max(...indents)).toBe(0);
  const screenshot = await page.screenshot({
    path: join(SCREENSHOTS_ROOT, "p4-4-light.png"),
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("captures conversation history after dark mode is applied before render", async ({ page }) => {
  await page.addInitScript(() => document.documentElement.classList.add("dark"));
  await page.goto("/p4-tree-playground-dark.html");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectSidebarTokenStyles(page);
  const screenshot = await page.screenshot({
    path: join(SCREENSHOTS_ROOT, "p4-4-dark.png"),
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("keeps conversation history scrollable at narrow width and supports modal keyboard selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p4-tree-playground.html");
  const panel = page.getByRole("region", { name: "Conversation history" });
  await expect(panel).toHaveAttribute("data-panel-layout", "drawer");
  const tree = page.getByRole("tree", { name: "Conversation messages" });
  await expect(tree).toBeVisible();
  await expect(tree).toHaveCSS("overflow-y", "auto");
  await expectSidebarTokenStyles(page);
  const screenshot = await page.screenshot({
    path: join(SCREENSHOTS_ROOT, "p4-4-narrow.png"),
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);

  const opener = page.getByRole("button", { name: "Choose a message" });
  await opener.focus();
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const filter = dialog.getByRole("searchbox", { name: "Search conversation messages" });
  await expect(filter).toBeFocused();
  await filter.fill("review checkpoint");
  // Search lists only the match, not the messages above it.
  const labelled = dialog.getByRole("treeitem", { name: /Review checkpoint/ });
  await expect(labelled).toBeVisible();
  await expect(dialog.getByRole("treeitem")).toHaveCount(1);
  await labelled.focus();
  await page.keyboard.press("Enter");
  await expect(labelled).toHaveAttribute("aria-selected", "true");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Message preview" })).toContainText(
    "The conversation keeps messages in order",
  );
  await expect(opener).toBeFocused();
});

test("opens on the current message, and PageDown and Enter work from the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/p4-tree-playground.html?panel=sidebar&entries=80");
  await page.getByRole("button", { name: "Choose a message" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const tree = dialog.getByRole("tree", { name: "Conversation messages" });
  const tabStop = tree.locator('[role="treeitem"][tabindex="0"]');
  await expect(tabStop).toHaveCount(1);
  await expect(tabStop).toContainText(/Current message/);
  await expect(tabStop).toBeInViewport();

  await tabStop.focus();
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem", { name: /Question 1 about/ })).toBeFocused();
  await page.keyboard.press("PageDown");
  const target = tree.getByRole("treeitem", { name: /Answer 10, after the check/ });
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute("aria-posinset", "11");
  await page.keyboard.press("Enter");
  await expect(target).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Message preview" })).toContainText(
    "Answer 10, after the check.",
  );
});

test("remains usable at 200% text zoom", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p4-tree-playground.html");
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });

  await expect(page.getByRole("region", { name: "Conversation history" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search conversation messages" })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Conversation messages" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Message preview" })).toBeVisible();
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(false);
});

test("keeps the rows aligned at 200% text zoom when the list is scrolled into the middle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/p4-tree-playground.html?panel=sidebar&entries=80");
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  const tree = page.getByRole("tree", { name: "Conversation messages" });
  await expect(tree).toBeVisible();
  await tree.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  // Rows that are on screen must be rendered: a window measured in the wrong unit leaves a gap.
  await expect
    .poll(() =>
      tree.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((item) => {
          const rect = item.getBoundingClientRect();
          return rect.bottom > box.top && rect.top < box.bottom;
        }).length;
      }),
    )
    .toBeGreaterThanOrEqual(2);
});

test("keeps a long conversation inside the sidebar and dialog scroll areas", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/p4-tree-playground.html?panel=sidebar&entries=80");

  const tree = page.getByRole("tree", { name: "Conversation messages" });
  await expect(tree).toBeVisible();
  const sidebarSearch = page.getByRole("searchbox", { name: "Search conversation messages" });
  await sidebarSearch.fill("unique request about database indexing");
  await expect(
    page.getByRole("treeitem", { name: /Unique request about database indexing/ }),
  ).toBeVisible();
  await sidebarSearch.fill("");
  const treeBox = await tree.boundingBox();
  const previewBox = await page.getByRole("region", { name: "Message preview" }).boundingBox();
  if (!treeBox || !previewBox)
    throw new Error("Expected the sidebar tree and preview to be visible.");
  expect(treeBox.width).toBeGreaterThan(180);
  expect(previewBox.width).toBeGreaterThan(180);
  await expect(page.getByRole("button", { name: "Jump to latest panel updates" })).toHaveCount(0);

  await page.getByRole("button", { name: "Choose a message" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Preview message" });
  await expect(confirm).toBeInViewport();
  await expect(dialog.getByRole("tree", { name: "Conversation messages" })).toHaveCSS(
    "overflow-y",
    "auto",
  );
  await dialog
    .getByRole("searchbox", { name: "Search conversation messages" })
    .fill("unique request about database indexing");
  await dialog.getByRole("treeitem", { name: /Unique request about database indexing/ }).click();
  await confirm.click();
  await expect(dialog).toBeHidden();
});

test("keeps the long-conversation dialog footer visible at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p4-tree-playground.html?panel=sidebar&entries=80");
  await page.getByRole("button", { name: "Choose a message" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Preview message" })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
});

test("bounds a 26-line message in its own scroll box and keeps the sidebar list usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/p4-tree-playground.html?panel=sidebar");
  const preview = page.getByRole("region", { name: "Message preview" });
  await expect(preview).toContainText("25. Read entry 75");
  const measured = await preview.evaluate((element) => {
    const box = element.parentElement;
    if (!box) return null;
    return {
      height: box.getBoundingClientRect().height,
      scrolls: box.scrollHeight > box.clientHeight,
    };
  });
  expect(measured?.scrolls).toBe(true);
  expect(measured?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(230);
  const treeBox = await page.getByRole("tree", { name: "Conversation messages" }).boundingBox();
  expect(treeBox?.height ?? 0).toBeGreaterThan(150);
  const screenshot = await page.screenshot({
    path: join(SCREENSHOTS_ROOT, "p4-4-sidebar-long.png"),
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("keeps the dialog's Cancel and confirm buttons clear of a 26-line message at narrow width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p4-tree-playground.html");
  await page.getByRole("button", { name: "Choose a message" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(dialog.getByRole("button", { name: "Preview message" })).toBeInViewport();
  await expect(cancel).toBeInViewport();
  // The message scrolls inside its own box (overflow auto), and that box ends above the footer.
  const scrollBox = await dialog
    .getByRole("region", { name: "Message preview" })
    .evaluate((element) => {
      const box = element.parentElement;
      return box
        ? { overflowY: getComputedStyle(box).overflowY, bottom: box.getBoundingClientRect().bottom }
        : null;
    });
  const footerTop = await cancel.evaluate((element) => element.getBoundingClientRect().top);
  expect(scrollBox?.overflowY).toBe("auto");
  expect(scrollBox?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(footerTop);
  const screenshot = await page.screenshot({
    path: join(SCREENSHOTS_ROOT, "p4-4-dialog-long-narrow.png"),
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("a late-loaded conversation opens on its current message without taking focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/p4-tree-playground.html?panel=sidebar&entries=80&load=late");
  const tree = page.getByRole("tree", { name: "Conversation messages" });
  await expect(tree).toBeVisible();
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toContainText(/Current message/);
  await expect(page.getByRole("button", { name: "Jump to latest panel updates" })).toHaveCount(0);
  const focusedRole = await page.evaluate(() => document.activeElement?.getAttribute("role"));
  expect(focusedRole).not.toBe("treeitem");
});
