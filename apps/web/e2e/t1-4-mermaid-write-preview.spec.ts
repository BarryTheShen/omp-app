import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { T1_REAL_RESULTS } from "../src/modules/T1/fixtures/real-results";
import type { SeedToolResult } from "./real-omp";
import {
  expect,
  openAllToolCards,
  realTest,
  screenshots,
  waitForFiniteAnimations,
} from "./real-omp";

const recordedWrite = T1_REAL_RESULTS.find((sample) => sample.name === "write: a file");
if (recordedWrite === undefined || typeof recordedWrite.result.details !== "object") {
  throw new Error("Missing recorded real file-write result for the Mermaid preview e2e.");
}
const mermaidPath = "docs/architecture.mmd";
const mermaidSource = "flowchart LR\n  Start --> Preview\n  Preview --> Finish\n";
const hostileMermaidPath = "docs/hostile.mmd";
const hostileMermaidSource = [
  '%%{init: {"securityLevel": "loose"}}%%',
  "flowchart LR",
  '  A["<img src=x onerror=window.__mermaidOnerror=true>"] --> B',
  '  click A callHack "run"',
].join("\n");
const recordedDetails = recordedWrite.result.details as Record<string, unknown>;
// Keep omp's recorded write-result envelope; replace only the target/source with diagram scenarios.
const makeMermaidWriteResult = (path: string, content: string): SeedToolResult => ({
  toolName: recordedWrite.toolName,
  args: { ...recordedWrite.args, path, content },
  result: {
    ...recordedWrite.result,
    details: { ...recordedDetails, resolvedPath: `/home/user/project/${path}` },
  },
  isError: false,
});
const mermaidWriteResult = makeMermaidWriteResult(mermaidPath, mermaidSource);
const hostileMermaidWriteResult = makeMermaidWriteResult(hostileMermaidPath, hostileMermaidSource);

realTest.use({ seedToolResults: { results: [mermaidWriteResult, hostileMermaidWriteResult] } });

realTest(
  "renders the Mermaid write result in light, dark, and narrow real-app scenes",
  async ({ realApp }) => {
    await mkdir(join(screenshots, "t1-4-mermaid"), { recursive: true });
    const openWrite = async (page: Page): Promise<void> => {
      await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
      await expect(page.getByTestId("t1-write-card").first()).toBeVisible({ timeout: 30_000 });
      await openAllToolCards(page);
      const preview = page.getByTestId("t1-write-mermaid-preview").first();
      await expect(preview).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("img", { name: `${mermaidPath} Mermaid diagram preview` }),
      ).toBeVisible();
      const diagramImage = preview.locator("img");
      await expect(diagramImage).toHaveAttribute("src", /^data:image\/svg\+xml;charset=utf-8,/);
      await expect
        .poll(() => diagramImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      await expect(preview.locator("svg")).toHaveCount(0);
      await preview.scrollIntoViewIfNeeded();
      const background = await page
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).not.toBe("rgba(0, 0, 0, 0)");
      await waitForFiniteAnimations(page);
    };
    const assertHostileWrite = async (page: Page): Promise<void> => {
      const card = page.getByTestId("t1-write-card").nth(1);
      const preview = card.getByTestId("t1-write-mermaid-preview");
      const fallback = card.getByText("Mermaid preview unavailable; the raw source is shown.");
      await expect(preview.or(fallback)).toBeVisible({ timeout: 30_000 });
      await expect(preview.locator("svg, script, [onerror]")).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const pageWindow = window as Window & {
              __mermaidClick?: boolean;
              __mermaidOnerror?: boolean;
            };
            return {
              click: pageWindow.__mermaidClick === true,
              onerror: pageWindow.__mermaidOnerror === true,
            };
          }),
        )
        .toEqual({ click: false, onerror: false });
      if ((await preview.count()) > 0) {
        const source = await preview.locator("img").getAttribute("src");
        expect(source).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
        const decoded = decodeURIComponent(source?.split(",", 2)[1] ?? "").toLowerCase();
        expect(decoded).not.toContain("onerror");
        expect(decoded).not.toContain("<script");
        expect(decoded).not.toContain("javascript:");
      }
    };

    const light = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => {
          const pageWindow = window as Window & {
            __mermaidClick?: boolean;
            __mermaidOnerror?: boolean;
            callHack?: () => void;
          };
          pageWindow.__mermaidClick = false;
          pageWindow.__mermaidOnerror = false;
          pageWindow.callHack = () => {
            pageWindow.__mermaidClick = true;
          };
        }),
    });
    await light.setViewportSize({ width: 1280, height: 900 });
    await openWrite(light);
    await assertHostileWrite(light);
    await expect(light.locator("html")).not.toHaveClass(/dark/);
    await light.screenshot({
      path: join(screenshots, "t1-4-mermaid", "light.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 900 });
    await openWrite(dark);
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await dark.screenshot({
      path: join(screenshots, "t1-4-mermaid", "dark.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 844 });
    await dark.getByTestId("t1-write-mermaid-preview").first().scrollIntoViewIfNeeded();
    await dark.screenshot({
      path: join(screenshots, "t1-4-mermaid", "narrow-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
