/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

const PROBE = readFileSync(resolve(process.cwd(), "e2e/overlay-recorder.js"), "utf8");
const BACKDROP = '[data-slot="dialog-overlay"]';
const RUNS = 7;

type RecordData = {
  readonly marks: Array<{ readonly n: string; readonly t: number }>;
  readonly frames: Array<[number, number, number, number]>;
  readonly ev: Array<{ readonly pr: number }>;
  readonly lists: readonly unknown[];
};

type Surface = {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly ready: (page: Page) => Promise<void>;
};

interface MetricSummary {
  readonly p50: number;
  readonly worst: number;
  readonly n: number;
}

interface SurfaceSummary {
  readonly seen: MetricSummary;
  readonly leave: MetricSummary;
  readonly removed: MetricSummary;
  readonly handler: MetricSummary;
  readonly lists: MetricSummary;
}

interface GuardSummary {
  readonly size: number;
  readonly metrics: Record<string, SurfaceSummary>;
  readonly snapBacks: number;
}

let baseline50: GuardSummary | undefined;

function median(values: readonly number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
}

function seededEntries(count: number): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const timestamp = Date.UTC(2026, 9, 3) + index * 1000;
    entries.push({
      type: "message",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Guard message ${index + 1}` }],
        ...(index % 2 === 1
          ? { api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop" }
          : {}),
        timestamp,
      },
    });
  }
  return entries;
}

const surfaces: readonly Surface[] = [
  {
    name: "settings",
    open: async (page) =>
      page.getByRole("button", { name: "Settings", exact: true }).first().click(),
    ready: async (page) =>
      expect(page.getByTestId("settings-screen")).toBeVisible({ timeout: 20_000 }),
  },
  {
    name: "palette",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Message input" }).focus();
      await page.keyboard.press("Control+k");
    },
    ready: async (page) =>
      expect(page.locator('[role="dialog"][aria-label="Command palette"]')).toBeVisible({
        timeout: 20_000,
      }),
  },
  {
    name: "model",
    open: async (page) => page.getByRole("button", { name: /^(Choose a model|Model:)/ }).click(),
    ready: async (page) =>
      expect(page.getByRole("dialog", { name: "Model and thinking" })).toBeVisible({
        timeout: 20_000,
      }),
  },
];

async function openPage(realApp: {
  open: (options?: { beforeLoad?: (page: Page) => Promise<unknown> }) => Promise<Page>;
}): Promise<Page> {
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.addInitScript({ content: PROBE });
    },
  });
  const rows = page.locator('[data-slot="u1-message-row"]');
  if ((await rows.count()) === 0) {
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  }
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole("button", { name: /^(Choose a model|Model:)/ })).toBeVisible({
    timeout: 45_000,
  });
  // Let the initial session catalog and transcript finish before timing dialog-only work.
  await page.waitForTimeout(5000);
  return page;
}

async function probeStart(page: Page, label: string): Promise<void> {
  await page.evaluate(
    (value) => (window as unknown as { __om: { start: (name: string) => void } }).__om.start(value),
    label,
  );
}

async function probeStop(page: Page): Promise<RecordData> {
  return page.evaluate(() =>
    (window as unknown as { __om: { stop: () => RecordData } }).__om.stop(),
  );
}

async function closeOverlay(page: Page): Promise<void> {
  await page.mouse.click(4, 4);
  await page.waitForFunction((selector) => document.querySelector(selector) === null, BACKDROP, {
    timeout: 20_000,
  });
}

async function cycle(
  page: Page,
  surface: Surface,
  run: number,
): Promise<{ readonly open: RecordData; readonly close: RecordData }> {
  await probeStart(page, `${surface.name}:open:${run}`);
  await surface.open(page);
  await surface.ready(page);
  await page.waitForTimeout(300);
  const open = await probeStop(page);
  await probeStart(page, `${surface.name}:close:${run}`);
  await closeOverlay(page);
  await page.waitForTimeout(300);
  const close = await probeStop(page);
  return { open, close };
}

function metric(record: RecordData, name: string): number {
  const names =
    name === "popup:data-closed"
      ? ["popup:data-closed", "backdrop:data-closed", "popup:aria-hidden", "backdrop:aria-hidden"]
      : [name];
  for (const candidate of names) {
    const value = median(record.marks.filter((mark) => mark.n === candidate).map((mark) => mark.t));
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

function handler(record: RecordData): number {
  return median(record.ev.map((entry) => entry.pr));
}
function summarize(values: readonly number[]): MetricSummary {
  const finite = values.filter(Number.isFinite);
  return {
    p50: median(finite),
    worst: finite.length === 0 ? Number.NaN : Math.max(...finite),
    n: finite.length,
  };
}

function snapBack(record: RecordData): number {
  let faded = false;
  for (const frame of record.frames) {
    if (frame[1] < 0.5) faded = true;
    if (faded && frame[1] >= 0.9) return 1;
  }
  return 0;
}

async function runGuard(page: Page, size: number): Promise<GuardSummary> {
  const bySurface: Record<
    string,
    { seen: number[]; leave: number[]; removed: number[]; handler: number[]; lists: number[] }
  > = {};
  let snapBacks = 0;
  for (const surface of surfaces) {
    bySurface[surface.name] = { seen: [], leave: [], removed: [], handler: [], lists: [] };
  }
  for (const surface of surfaces) {
    await cycle(page, surface, 0);
    for (let run = 1; run <= RUNS; run += 1) {
      const result = await cycle(page, surface, run);
      const values = bySurface[surface.name];
      if (values === undefined) throw new Error(`missing ${surface.name} guard samples`);
      values.seen.push(metric(result.open, "popup:seen"));
      values.leave.push(metric(result.close, "popup:data-closed"));
      values.removed.push(metric(result.close, "popup:removed"));
      values.handler.push(handler(result.open), handler(result.close));
      values.lists.push(result.open.lists.length);
      snapBacks += snapBack(result.close);
    }
  }
  const metrics: GuardSummary["metrics"] = {};
  for (const surface of surfaces) {
    const values = bySurface[surface.name];
    if (values === undefined) throw new Error(`missing ${surface.name} guard samples`);
    metrics[surface.name] = {
      seen: summarize(values.seen),
      leave: summarize(values.leave),
      removed: summarize(values.removed),
      handler: summarize(values.handler),
      lists: summarize(values.lists),
    };
  }
  return { size, metrics, snapBacks };
}

function assertGuard(summary: GuardSummary): void {
  expect(summary.snapBacks, `${summary.size}-message guard snap-backs`).toBe(0);
  if (baseline50 === undefined) return;
  for (const surface of surfaces) {
    const before = baseline50.metrics[surface.name];
    const after = summary.metrics[surface.name];
    if (before === undefined || after === undefined) {
      throw new Error(`missing ${surface.name} guard metrics`);
    }
    if (summary.size === 500) {
      expect(after.leave.p50, `${surface.name} leave p50 at 500 messages`).toBeLessThanOrEqual(120);
      if (Number.isFinite(before.leave.p50) && before.leave.p50 > 0) {
        expect(
          after.leave.p50 / before.leave.p50,
          `${surface.name} leave 500/50 ratio`,
        ).toBeLessThanOrEqual(3);
      }
      if (surface.name === "palette" && before.seen.p50 > 0) {
        expect(after.seen.p50 / before.seen.p50, "palette seen 500/50 ratio").toBeLessThanOrEqual(
          1.5,
        );
      }
      if (surface.name === "model")
        expect(after.seen.p50, "model seen absolute budget at 500 messages").toBeLessThanOrEqual(
          60,
        );
    }
    for (const metricName of ["removed", "handler"] as const) {
      if (!Number.isFinite(before[metricName].p50) || before[metricName].p50 <= 0) continue;
      expect(
        after[metricName].p50 / before[metricName].p50,
        `${surface.name} ${metricName} 500/50 ratio`,
      ).toBeLessThanOrEqual(1.5);
    }
  }
}

realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });
realTest.setTimeout(1_200_000);
realTest.describe.configure({ mode: "serial" });

if (process.env.OMP_APP_TOUR === "1") {
  realTest.describe("overlay latency guard at 50 messages", () => {
    realTest.use({ seedEntries: { entries: seededEntries(50) } });
    realTest("records seen, removed and Event Timing processing", async ({ realApp }) => {
      const page = await openPage(realApp);
      baseline50 = await runGuard(page, 50);
      console.log(`MENUS GUARD size=50 ${JSON.stringify(baseline50)}`);
      for (const [name, metrics] of Object.entries(baseline50.metrics)) {
        console.log(`MENUS TABLE size=50 surface=${name} ${JSON.stringify(metrics)}`);
      }
      assertGuard(baseline50);
    });
  });

  realTest.describe("overlay latency guard at 500 messages", () => {
    realTest.use({ seedEntries: { entries: seededEntries(500) } });
    realTest("keeps 500-to-50 ratios within 1.5x", async ({ realApp }) => {
      if (baseline50 === undefined) throw new Error("50-message guard did not run");
      const page = await openPage(realApp);
      const summary = await runGuard(page, 500);
      console.log(`MENUS GUARD size=500 ${JSON.stringify(summary)}`);
      for (const [name, metrics] of Object.entries(summary.metrics)) {
        console.log(`MENUS TABLE size=500 surface=${name} ${JSON.stringify(metrics)}`);
      }
      assertGuard(summary);
    });
  });
}
