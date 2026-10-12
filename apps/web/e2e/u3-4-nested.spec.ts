/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { openAllToolCards, openToolCard, realTest, sendPrompt, startChat } from "./real-omp";

const WEB_ROOT = process.cwd();
const DIST_ROOT = join(WEB_ROOT, "dist");
const SCREENSHOTS = join(WEB_ROOT, "../../.data/screenshots");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U3/tool-card/nested-playground.tsx",
      "--outdir",
      "dist/u3-nested-playground",
      "--target=browser",
    ],
    { cwd: WEB_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the nested playground.");
  for (const dark of [false, true]) {
    const suffix = dark ? "-dark" : "";
    const className = dark ? ' class="dark"' : "";
    writeFileSync(
      join(DIST_ROOT, `u3-nested-playground${suffix}.html`),
      `<!doctype html>
<html lang="en"${className}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/u3-nested-playground/nested-playground.js"></script>
  </head>
  <body>
    <div id="u3-nested-playground-root"></div>
  </body>
</html>
`,
    );
  }
}

async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("main").evaluate((main) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(main).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return {
      background,
      token,
      normalizedBackground: normalize(background),
      normalizedToken: normalize(token),
    };
  });
  expect(colors.token).not.toBe("");
  expect(colors.normalizedBackground).toBe(colors.normalizedToken);
}

test.describe("nested transcript playground", () => {
  test.beforeAll(() => {
    mkdirSync(SCREENSHOTS, { recursive: true });
    buildPlaygroundPage();
  });

  test("renders task transcripts under their cards with real renderers and bounded states", async ({
    page,
  }) => {
    await page.goto("/u3-nested-playground.html");
    await expect(page.getByTestId("u3-nested-playground")).toBeVisible();
    const nestedCase = page.getByTestId("nested-recursion-case");
    await expect(nestedCase.getByText("The parent task called a child.")).toBeVisible();
    await expect(nestedCase.getByText("Nested response.")).toBeVisible();
    await expect(nestedCase.getByText("Deepest response.")).toBeVisible();
    await expect(nestedCase.getByText("Great-grandchild response.")).toBeVisible();
    await expect(nestedCase.getByTestId("nested-tool-renderer-grandchild-call")).toHaveText(
      "probe renderer from the parent",
    );
    await expect(nestedCase.getByTestId("nested-tool-renderer-great-grandchild-call")).toHaveText(
      "probe renderer from the parent",
    );
    const nestedLevels = nestedCase.locator('[data-read-only="true"]');
    await expect(nestedLevels).toHaveCount(4);
    await expect(nestedLevels.nth(2).getByTestId("u3-bash-card")).toBeVisible();
    await openToolCard(nestedLevels.nth(2).getByTestId("u3-bash-card"));
    await expect(nestedLevels.nth(2).getByTestId("u3-bash-stdout")).toContainText(
      "Nested bash output.",
    );
    await expect(nestedCase.getByRole("textbox")).toHaveCount(0);
    await expect(
      nestedCase.getByRole("button", {
        name: /stop|approve|reject|answer|submit|edit|branch|regenerate|steer/i,
      }),
    ).toHaveCount(0);
    await expect(page.getByText("No nested messages")).toBeVisible();
    await expect(page.getByText("This transcript contains a repeated task.")).toBeVisible();
    await expect(page.getByText("This transcript contains a loop.")).toBeVisible();
    await expect(page.getByText("Some messages could not be displayed.")).toBeVisible();
    await expect(page.getByText("This transcript is deeper than 32 levels.")).toBeVisible();

    const firstTask = page
      .getByTestId("multiple-task-case")
      .locator('[data-nested-tool-call-id="task-a"]');
    const secondTask = page
      .getByTestId("multiple-task-case")
      .locator('[data-nested-tool-call-id="task-b"]');
    await expect(firstTask.getByRole("group", { name: /Probe task transcript/ })).toBeVisible();
    await expect(secondTask.getByRole("group", { name: /Probe task transcript/ })).toBeVisible();
    await expect(firstTask.locator('[data-read-only="true"]')).toContainText(
      "First task transcript.",
    );
    await expect(secondTask.locator('[data-read-only="true"]')).toContainText(
      "Second task transcript.",
    );

    const pairedResult = page.getByTestId("paired-tool-result-case");
    await expect(pairedResult.getByTestId("u3-bash-card")).toHaveCount(1);
    await expect(pairedResult.getByRole("button", { name: "bash: Complete" })).toBeVisible();
    await openAllToolCards(page);
    await expect(pairedResult.getByText("Paired bash output.").first()).toBeVisible();
    await expect(pairedResult.getByText("Waiting for bash output…")).toHaveCount(0);

    await expectTokenBackground(page);
    await page.screenshot({ path: join(SCREENSHOTS, "u3.4-nested-light.png"), fullPage: true });
    await page.goto("/u3-nested-playground-dark.html");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("u3-nested-playground")).toBeVisible();
    await expectTokenBackground(page);
    await page.screenshot({ path: join(SCREENSHOTS, "u3.4-nested-dark.png"), fullPage: true });

    await page.goto("/u3-nested-playground.html");
    await expectTokenBackground(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByTestId("nested-recursion-case").getByTestId("u3-bash-card"),
    ).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await page.screenshot({ path: join(SCREENSHOTS, "u3.4-nested-narrow.png"), fullPage: true });
  });
});

realTest("real omp renders the task card and its result", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  const composer = await startChat(page);
  await sendPrompt(composer, "spawn_subagent");

  const taskTool = page.getByRole("button", { name: "task: Complete" });
  await expect(taskTool).toBeVisible({ timeout: 60_000 });
  await openAllToolCards(page);
  await expect(page.getByText(/Spawned agent.*NestedProbe/).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/subagent yielded successfully/).first()).toBeVisible({
    timeout: 60_000,
  });
  expect(realApp.problems).toEqual([]);
});
