/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1618 (gap 3 of #1177). The fake model starts a worker (NestedParent) that starts one nested worker
 * (NestedChild), which waits for a steer. The nested worker's card in the chat has the Agent Hub's cancel control
 * and message box. A steer reaches it and it finishes; a cancel stops it. In both cases its row leaves the
 * Running list of the Agent Hub.
 */
const STEER_TEXT = "steer_probe: wrap up now";
const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const NESTED_WIDTH_PAGE = "nested-width-check";

function buildNestedWidthPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P1/transcript/nested-width-playground.tsx",
      "--outdir",
      `dist/${NESTED_WIDTH_PAGE}`,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(join(DIST_ROOT, NESTED_WIDTH_PAGE)).find((file) => file.endsWith(".js"));
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (js === undefined || css === undefined) {
    throw new Error("The nested width check did not build with the app stylesheet.");
  }
  writeFileSync(
    join(DIST_ROOT, `${NESTED_WIDTH_PAGE}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Nested worker width check</title>
  </head>
  <body>
    <div id="nested-width-root"></div>
    <script type="module" src="/${NESTED_WIDTH_PAGE}/${js}"></script>
  </body>
</html>
`,
  );
}

realTest.beforeAll(() => {
  buildNestedWidthPage();
});
const WIDE = { width: 1280, height: 900 };
const NARROW = { width: 390, height: 844 };

realTest.setTimeout(420_000);

/** Starts the chat's worker tree and returns the nested worker's card, opened, with its messages on screen. */
async function openNestedCard(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "spawn_nested_probe");
  const outer = page.getByTestId("t5-task-card").first();
  await expect(outer).toBeVisible({ timeout: 120_000 });
  await openToolCard(outer);
  const nested = outer.getByTestId("t5-task-card").first();
  await expect(nested).toBeVisible({ timeout: 120_000 });
  await openToolCard(nested);
  return nested;
}

/** The worker's name, as its nested card's Cancel button names it: "Cancel <name>". */
async function workerNameOf(nested: Locator): Promise<string> {
  const cancel = nested.getByRole("button", { name: /^Cancel / });
  await expect(cancel).toBeEnabled({ timeout: 120_000 });
  const name = ((await cancel.getAttribute("aria-label")) ?? "").replace(/^Cancel /, "");
  expect(name).not.toBe("");
  return name;
}

/** The steer editor fills its task card's content box without pushing the page past the viewport. */
async function expectEditorWithinCard(
  editor: Locator,
  cardContentBox: Locator,
  page: Page,
): Promise<void> {
  const editorBox = await editor.boundingBox();
  const contentBox = await cardContentBox.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left:
        rect.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
      right:
        rect.right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight),
    };
  });
  expect(editorBox).not.toBeNull();
  if (editorBox === null) throw new Error("The nested editor is not visible.");
  expect(Math.abs(editorBox.x - contentBox.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(editorBox.x + editorBox.width - contentBox.right)).toBeLessThanOrEqual(2);
  const pageWidth = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);
}

realTest(
  "a nested worker's card steers it: the message reaches the worker, and the worker leaves the Running list",
  async ({ realApp }) => {
    const page = await realApp.open();
    const nested = await openNestedCard(page);
    const worker = await workerNameOf(nested);
    const box = nested.getByRole("textbox", { name: `Message to ${worker}` });
    await expect(nested.getByRole("button", { name: `Send message to ${worker}` })).toBeVisible();
    await expect(box).toBeEnabled({ timeout: 120_000 });
    const controls = nested.locator('[data-slot="p1-nested-controls"]');
    await controls.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const editor = controls.locator('[data-slot="p1-steer-editor"]');
    await expect(editor).toHaveCSS("border-top-width", "1px");
    await mkdir(screenshots, { recursive: true });
    await controls.screenshot({ path: join(screenshots, "fix-1618-nested-light.png") });
    await nested.screenshot({ path: join(screenshots, "fix-1618-nested-card-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(editor).toHaveCSS("border-top-width", "1px");
    await waitForFiniteAnimations(page);
    await controls.screenshot({ path: join(screenshots, "fix-1618-nested-dark.png") });
    await nested.screenshot({ path: join(screenshots, "fix-1618-nested-card-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize(NARROW);
    await controls.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expectEditorWithinCard(
      editor,
      nested.locator('[data-slot="u3-tool-card-content"] > div > div').first(),
      page,
    );
    await expect(editor).toHaveCSS("border-top-width", "1px");
    await waitForFiniteAnimations(page);
    await controls.screenshot({ path: join(screenshots, "fix-1618-nested-narrow.png") });
    await nested.screenshot({ path: join(screenshots, "fix-1618-nested-card-narrow.png") });
    await page.setViewportSize(WIDE);

    await box.fill(STEER_TEXT);
    await box.press("Enter");
    await expect(nested.getByText(STEER_TEXT, { exact: true })).toBeVisible({ timeout: 120_000 });

    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Running.*NestedChild/ })).toHaveCount(0, {
      timeout: 180_000,
    });
    await expect(hub.getByRole("option", { name: /Finished.*NestedChild/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a worker nested inside another worker keeps its editor within its card at depth two",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(NARROW);
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/${NESTED_WIDTH_PAGE}.html`);
    expect(page.viewportSize()?.width).toBe(NARROW.width);

    const parentCard = page.getByTestId("depth-one-card");
    const childCard = page.getByTestId("depth-two-card");
    const parentEditor = parentCard.locator('[data-slot="p1-steer-editor"]').first();
    const childEditor = childCard.locator('[data-slot="p1-steer-editor"]');
    await expect(parentEditor).toHaveCSS("border-top-width", "1px");
    await expect(childEditor).toHaveCSS("border-top-width", "1px");
    await expectEditorWithinCard(parentEditor, parentCard, page);
    await expectEditorWithinCard(childEditor, childCard, page);
    await expect(
      childCard.getByRole("textbox", { name: "Message to NestedParent.NestedChild.NestedParent" }),
    ).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a nested worker's card cancels it: the worker stops, and its row leaves the Running list",
  async ({ realApp }) => {
    const page = await realApp.open();
    const nested = await openNestedCard(page);
    const cancel = nested.getByRole("button", { name: /^Cancel / });
    await expect(cancel).toBeEnabled({ timeout: 120_000 });
    await cancel.click();
    await expect(nested.getByRole("button", { name: /^Cancel / })).toHaveCount(0, {
      timeout: 180_000,
    });

    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /Running.*NestedChild/ })).toHaveCount(0, {
      timeout: 180_000,
    });
    await expect(hub.getByRole("option", { name: /Cancelled.*NestedChild/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Escape in a nested card's message box, with nothing typed, leaves the Agent Hub's focused view",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.getByRole("tab", { name: "Agents" }).click();
    const hub = page.getByRole("region", { name: "Agent Hub" });
    await sendPrompt(composer, "spawn_nested_probe");
    const parent = hub
      .getByRole("option")
      .filter({ has: page.getByText("NestedParent", { exact: true }) })
      .filter({ hasText: "Running" });
    await expect(parent).toHaveCount(1, { timeout: 120_000 });
    await parent.click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const focused = page.getByRole("region", { name: /^Transcript of / });
    await expect(focused).toBeVisible({ timeout: 60_000 });
    const nested = focused.getByTestId("t5-task-card").first();
    await expect(nested).toBeVisible({ timeout: 120_000 });
    await openToolCard(nested);
    const worker = await workerNameOf(nested);
    const box = nested.getByRole("textbox", { name: `Message to ${worker}` });
    await expect(box).toBeEnabled({ timeout: 120_000 });
    await box.focus();
    await page.keyboard.press("Escape");
    await expect(hub).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
