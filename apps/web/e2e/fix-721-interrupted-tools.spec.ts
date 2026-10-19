import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { T1_REAL_RESULTS } from "../src/modules/T1/fixtures/real-results";
import { expect, type RealApp, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const interrupted = T1_REAL_RESULTS.find((sample) => sample.reads === "interrupted");
const skipped = T1_REAL_RESULTS.find((sample) => sample.reads === "skipped");
const started = T1_REAL_RESULTS.find(
  (sample) => sample.name.includes("[scripted]") && sample.reads === "interrupted",
);
if (interrupted === undefined || skipped === undefined || started === undefined)
  throw new Error("Issue #721 fixtures are missing");
const SAMPLES = [interrupted, skipped, started] as const;

const INTERRUPTED_TEXT = "Tool execution was aborted: Interrupted by user";
const SKIPPED_TEXT =
  "Skipped due to queued user message. Do not count this skipped result as completed work or verification. After the queued message is handled on the next step, retry the skipped tool if it is still needed.";

realTest.use({
  seedToolResults: {
    results: SAMPLES.map((sample) => ({
      toolName: sample.toolName,
      args: sample.args,
      result: sample.result,
      isError: sample.isError,
    })),
  },
});
realTest.setTimeout(180_000);

async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((shell) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(shell).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return { background: normalize(background), token: normalize(token), rawToken: token };
  });
  expect(colors.rawToken).not.toBe("");
  expect(colors.background).toBe(colors.token);
}

async function expectCalmCard(
  page: Page,
  sampleIndex: number,
  label: "Interrupted" | "Skipped",
  text: string,
): Promise<void> {
  if ((await page.getByTestId("t1-write-card").count()) === 0) {
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText(`end of sample ${SAMPLES.length - 1}`)).toBeVisible({
      timeout: 120_000,
    });
  }
  const card = page
    .getByTestId("t1-write-card")
    .nth(sampleIndex)
    .locator('[data-slot="u3-tool-card"]');
  await expect(card).toHaveAttribute("data-phase", "error");
  const trigger = card.locator('[data-slot="u3-tool-card-trigger"]');
  await expect(trigger).toHaveAttribute("aria-label", `write: ${label}`);
  const chip = card.locator('[data-slot="u3-tool-card-status"]');
  await expect(chip).toHaveText(label);
  await expect(chip).toHaveClass(/text-muted-foreground/);
  await expect(chip).not.toHaveClass(/text-destructive/);
  await expect(card.getByRole("alert")).toHaveCount(0);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(card.getByText(text, { exact: true })).toBeVisible();
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toBeInViewport();
}

async function openDarkPage(
  realApp: RealApp,
  sampleIndex: number,
  label: "Interrupted" | "Skipped",
  text: string,
): Promise<Page> {
  const page = await realApp.open({
    beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectCalmCard(page, sampleIndex, label, text);
  return page;
}

async function screenshotStates(
  page: Page,
  realApp: RealApp,
  sampleIndex: number,
  label: "Interrupted" | "Skipped",
  text: string,
  fileLabel: "interrupted" | "skipped",
): Promise<void> {
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expectCalmCard(page, sampleIndex, label, text);
  await expectTokenBackground(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, `fix-721-${fileLabel}-light.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectCalmCard(page, sampleIndex, label, text);
  await expectTokenBackground(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, `fix-721-${fileLabel}-390.png`),
    fullPage: true,
  });

  const dark = await openDarkPage(realApp, sampleIndex, label, text);
  await expectTokenBackground(dark);
  await waitForFiniteAnimations(dark);
  await dark.screenshot({
    path: join(screenshots, `fix-721-${fileLabel}-dark.png`),
    fullPage: true,
  });
  await dark.close();
}

realTest(
  "recorded interrupted and started-interrupted calls read Interrupted; never-run skip reads Skipped",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await expectCalmCard(page, 0, "Interrupted", INTERRUPTED_TEXT);
    await screenshotStates(page, realApp, 0, "Interrupted", INTERRUPTED_TEXT, "interrupted");
    await expectCalmCard(page, 2, "Interrupted", SKIPPED_TEXT);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a recorded never-run skipped call reads Skipped with omp's exact result text",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await expectCalmCard(page, 1, "Skipped", SKIPPED_TEXT);
    await screenshotStates(page, realApp, 1, "Skipped", SKIPPED_TEXT, "skipped");
    expect(realApp.problems).toEqual([]);
  },
);
