import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  openToolCard,
  realTest,
  type SeedToolResult,
  screenshots,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue 1265: a picture a tool returns is drawn below the call, never left as base64 text. Two MCP
 * tool results are seeded into one real chat on real omp, shaped as omp sends them: one returns a PNG
 * and no text; the other returns an SVG, which no card draws, so the card says so in plain words.
 */

// A 24 by 24 pixel PNG, as base64.
const PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYAQMAAADaua+7AAAAA1BMVEUlY+vg9LpFAAAADElEQVQI12NgoC0AAABgAAE3kBd4AAAAAElFTkSuQmCC";
const VECTOR = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>',
).toString("base64");

const SAMPLES: readonly SeedToolResult[] = [
  {
    toolName: "mcp__fixture_show_picture",
    args: { name: "fixture" },
    result: { content: [{ type: "image", data: PICTURE, mimeType: "image/png" }] },
    isError: false,
  },
  {
    toolName: "mcp__fixture_draw_vector",
    args: {},
    result: { content: [{ type: "image", data: VECTOR, mimeType: "image/svg+xml" }] },
    isError: false,
  },
];

realTest.use({ seedToolResults: { results: SAMPLES } });

realTest(
  "a picture a tool returns is drawn below its call; a picture no card can draw says why",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("end of sample 1")).toBeVisible({ timeout: 60_000 });
    const folder = join(screenshots, "fix-1265-tool-images");
    await mkdir(folder, { recursive: true });

    const pictureCard = page.locator('[data-tool-name="mcp__fixture_show_picture"]');
    await expect(pictureCard).toBeVisible();
    await openToolCard(pictureCard);
    const picture = pictureCard.locator('[data-slot="tool-result-image"] img');
    await expect(picture).toBeVisible();
    // The browser decoded omp's picture: it has its own size, 24 by 24 pixels.
    await expect
      .poll(() => picture.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBe(24);
    await expect(pictureCard.getByText(PICTURE.slice(0, 16))).toHaveCount(0);
    await expect(pictureCard.getByText("Result: array")).toHaveCount(0);

    const vectorCard = page.locator('[data-tool-name="mcp__fixture_draw_vector"]');
    await expect(vectorCard).toBeVisible();
    await openToolCard(vectorCard);
    await expect(vectorCard.getByText("This type of image cannot be shown here.")).toBeVisible();
    await expect(vectorCard.locator("img")).toHaveCount(0);
    await expect(vectorCard.getByText(VECTOR.slice(0, 16))).toHaveCount(0);
    await page.screenshot({ path: join(folder, "light.png"), fullPage: true });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(folder, "dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(folder, "narrow.png"), fullPage: true });
  },
);
