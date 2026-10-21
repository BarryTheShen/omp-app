/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

const PROBE = readFileSync(resolve(process.cwd(), "e2e/overlay-recorder.js"), "utf8");
const BACKDROP = '[data-slot="dialog-overlay"]';
const RUNS = 14;

type RecordData = {
  readonly marks: Array<{ readonly n: string; readonly t: number }>;
  readonly frames: Array<[number, number, number, number]>;
  readonly ev: Array<{ readonly n: string; readonly d: number; readonly pr: number }>;
  readonly lists: readonly { readonly s: number; readonly ms: number; readonly kb: number }[];
  readonly pending: number;
};

type Surface = {
  readonly name: string;
  readonly prepareOpen: (page: Page) => Promise<() => Promise<void>>;
  readonly readySelector: string;
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
  readonly listEnd: MetricSummary;
  readonly contextClick: MetricSummary;
  readonly seenToListEnd: MetricSummary;
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
    prepareOpen: async (page) => {
      const button = await page
        .getByRole("button", { name: "Settings", exact: true })
        .first()
        .elementHandle();
      if (button === null) throw new Error("Settings opener was not found before measurement.");
      const bounds = await button.boundingBox();
      if (bounds === null) throw new Error("Settings opener has no bounds before measurement.");
      return () => page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    },
    readySelector: '[role="dialog"][aria-label="Settings"]',
  },
  {
    name: "palette",
    prepareOpen: async (page) => {
      const composer = await page.getByRole("textbox", { name: "Message input" }).elementHandle();
      if (composer === null) throw new Error("Message composer was not found before measurement.");
      await composer.focus();
      return () => page.keyboard.press("Control+k");
    },
    readySelector: '[role="dialog"][aria-label="Command palette"]',
  },
  {
    name: "model",
    prepareOpen: async (page) => {
      const button = await page
        .getByRole("button", { name: /^(Choose a model|Model:)/ })
        .elementHandle();
      if (button === null) throw new Error("Model opener was not found before measurement.");
      const bounds = await button.boundingBox();
      if (bounds === null) throw new Error("Model opener has no bounds before measurement.");
      return () => page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    },
    readySelector: '[role="dialog"][aria-label="Model and thinking"]',
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
): Promise<{
  readonly open: RecordData;
  readonly close: RecordData;
  readonly contextClick?: RecordData;
}> {
  const performOpen = await surface.prepareOpen(page);
  await probeStart(page, `${surface.name}:open:${run}`);
  await performOpen();
  await page.waitForFunction(
    (selector) => {
      const record = (
        window as unknown as {
          __om?: { readonly rec?: { readonly seen?: { readonly pop?: boolean } } };
        }
      ).__om?.rec;
      return document.querySelector(selector) !== null && record?.seen?.pop === true;
    },
    surface.readySelector,
    { timeout: 20_000 },
  );
  if (surface.name === "settings") {
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]');
        if (dialog === null) return false;
        const tabs = dialog.querySelectorAll('[aria-label="Context sections"] [role="tab"]');
        const text = dialog.textContent ?? "";
        const pending = (
          window as unknown as { __om?: { readonly calls?: { readonly size: number } } }
        ).__om?.calls?.size;
        return (
          tabs.length === 4 &&
          !text.includes("Loading context settings…") &&
          !text.includes("Loading appearance settings…") &&
          pending === 0
        );
      },
      null,
      { timeout: 20_000 },
    );
  } else {
    await page.waitForTimeout(300);
  }
  const open = await probeStop(page);
  let contextClick: RecordData | undefined;
  if (surface.name === "settings") {
    const contextButton = await page
      .locator('[aria-label="Settings categories"] button')
      .filter({ hasText: /^Context$/ })
      .elementHandle();
    if (contextButton === null) throw new Error("Context tab was not found after Settings loaded.");
    const bounds = await contextButton.boundingBox();
    if (bounds === null) throw new Error("Context tab has no bounds after Settings loaded.");
    await probeStart(page, `settings:context:${run}`);
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.waitForFunction(
      () => {
        const record = (
          window as unknown as {
            __om?: {
              readonly rec?: {
                readonly marks?: readonly { readonly n: string; readonly t: number }[];
                readonly frames?: readonly [number, number, number, number][];
              };
            };
          }
        ).__om?.rec;
        const click = record?.marks?.find((mark) => mark.n === "in:click");
        return click !== undefined && (record?.frames ?? []).some((frame) => frame[0] >= click.t);
      },
      null,
      { timeout: 20_000 },
    );
    contextClick = await probeStop(page);
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]');
        if (dialog === null) return false;
        return (
          dialog.querySelector('[aria-label="Context sections"] [role="tab"]') !== null &&
          dialog.querySelector('[placeholder="Search context settings"]') !== null &&
          !dialog.textContent?.includes("Loading context settings…")
        );
      },
      null,
      { timeout: 20_000 },
    );
  }
  await probeStart(page, `${surface.name}:close:${run}`);
  await closeOverlay(page);
  await page.waitForTimeout(300);
  const close = await probeStop(page);
  return { open, close, ...(contextClick === undefined ? {} : { contextClick }) };
}

function contextClickDuration(record: RecordData): number {
  const click = record.ev.filter((entry) => entry.n === "click").at(-1);
  if (click !== undefined) return click.d;
  const clickAt = record.marks.find((mark) => mark.n === "in:click")?.t;
  if (clickAt === undefined) return Number.NaN;
  const nextFrame = record.frames.find((frame) => frame[0] >= clickAt);
  return nextFrame === undefined ? Number.NaN : nextFrame[0] - clickAt;
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

function triggerToSeen(record: RecordData, surface: string): number {
  const triggerNames = surface === "palette" ? ["in:keydown:k", "in:click"] : ["in:click"];
  const trigger = record.marks.find((mark) => triggerNames.includes(mark.n));
  return trigger === undefined ? Number.NaN : metric(record, "popup:seen") - trigger.t;
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
    {
      seen: number[];
      leave: number[];
      removed: number[];
      handler: number[];
      lists: number[];
      listEnds: number[];
      seenToListEnds: number[];
      contextClick: number[];
    }
  > = {};
  let snapBacks = 0;
  for (const surface of surfaces) {
    bySurface[surface.name] = {
      seen: [],
      leave: [],
      removed: [],
      handler: [],
      lists: [],
      listEnds: [],
      seenToListEnds: [],
      contextClick: [],
    };
  }
  for (const surface of surfaces) {
    await cycle(page, surface, 0);
    for (let run = 1; run <= RUNS; run += 1) {
      const result = await cycle(page, surface, run);
      const values = bySurface[surface.name];
      if (values === undefined) throw new Error(`missing ${surface.name} guard samples`);
      const popupSeen = metric(result.open, "popup:seen");
      const seen = triggerToSeen(result.open, surface.name);
      const listEnd =
        result.open.pending > 0
          ? Number.POSITIVE_INFINITY
          : Math.max(0, ...result.open.lists.map((call) => call.s + call.ms));
      values.seen.push(seen);
      values.leave.push(metric(result.close, "popup:data-closed"));
      values.removed.push(metric(result.close, "popup:removed"));
      values.handler.push(handler(result.open), handler(result.close));
      values.lists.push(result.open.lists.length + result.open.pending);
      values.listEnds.push(listEnd);
      if (surface.name === "settings") values.seenToListEnds.push(Math.max(0, listEnd - popupSeen));
      if (result.contextClick !== undefined) {
        values.contextClick.push(contextClickDuration(result.contextClick));
      }
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
      listEnd: summarize(values.listEnds),
      seenToListEnd: summarize(values.seenToListEnds),
      contextClick: summarize(values.contextClick),
    };
  }
  const settingsSamples = bySurface.settings;
  if (settingsSamples === undefined) throw new Error("missing Settings timing samples");
  const raw = (values: readonly number[]): string =>
    values.map((value) => (Number.isFinite(value) ? value.toFixed(1) : "pending")).join(",");
  console.log(
    `PR3_RAW_SPLIT size=${size} field=clickToSeen n=${settingsSamples.seen.length} values=${raw(settingsSamples.seen)}`,
  );
  console.log(
    `PR3_RAW_SPLIT size=${size} field=seenToLastList n=${settingsSamples.seenToListEnds.length} values=${raw(settingsSamples.seenToListEnds)}`,
  );
  console.log(
    `PR3_RAW_SPLIT size=${size} field=contextClick n=${settingsSamples.contextClick.length} values=${raw(settingsSamples.contextClick)}`,
  );
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
    if (summary.size === 500 && surface.name === "settings") {
      expect(after.lists.worst, "Settings list calls per open").toBeLessThanOrEqual(2);
      expect(
        after.seenToListEnd.p50,
        "Settings list results finish within 150 ms after the dialog appears (p50)",
      ).toBeLessThanOrEqual(150);
      expect(after.contextClick.p50, "first Context click p50 against B8").toBeLessThanOrEqual(100);
    }
    if (summary.size === 500) {
      // Palette timing stays diagnostic; this PR gates the Settings interaction.
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
      const settings = baseline50.metrics.settings;
      if (settings === undefined) throw new Error("50-message Settings metrics were not collected");
      console.log(
        `PR3_METRICS size=50 lists=${settings.lists.p50}/${settings.lists.worst} listEnd=${settings.listEnd.p50}/${settings.listEnd.worst} context=${settings.contextClick.p50}/${settings.contextClick.worst}`,
      );
      console.log(
        `PR3_LIST_SPLIT size=50 clickToSeen=${settings.seen.p50.toFixed(1)}/${settings.seen.worst.toFixed(1)} ms n=${settings.seen.n}; seenToLastList=${settings.seenToListEnd.p50.toFixed(1)}/${settings.seenToListEnd.worst.toFixed(1)} ms n=${settings.seenToListEnd.n}`,
      );
      assertGuard(baseline50);
    });
  });

  realTest.describe("overlay latency guard at 500 messages", () => {
    realTest.use({ seedEntries: { entries: seededEntries(500) } });
    realTest(
      "keeps Settings responsive and reports palette timing at 500 messages",
      async ({ realApp }) => {
        if (baseline50 === undefined) throw new Error("50-message guard did not run");
        const page = await openPage(realApp);
        const summary = await runGuard(page, 500);
        console.log(`MENUS GUARD size=500 ${JSON.stringify(summary)}`);
        for (const [name, metrics] of Object.entries(summary.metrics)) {
          console.log(`MENUS TABLE size=500 surface=${name} ${JSON.stringify(metrics)}`);
        }
        const settings = summary.metrics.settings;
        if (settings === undefined)
          throw new Error("500-message Settings metrics were not collected");
        console.log(
          `PR3_METRICS size=500 lists=${settings.lists.p50}/${settings.lists.worst} listEnd=${settings.listEnd.p50}/${settings.listEnd.worst} context=${settings.contextClick.p50}/${settings.contextClick.worst}`,
        );
        console.log(
          `PR3_LIST_SPLIT size=500 clickToSeen=${settings.seen.p50.toFixed(1)}/${settings.seen.worst.toFixed(1)} ms n=${settings.seen.n}; seenToLastList=${settings.seenToListEnd.p50.toFixed(1)}/${settings.seenToListEnd.worst.toFixed(1)} ms n=${settings.seenToListEnd.n}`,
        );
        const palette50 = baseline50.metrics.palette;
        const palette500 = summary.metrics.palette;
        if (palette50 === undefined || palette500 === undefined) {
          throw new Error("palette timing metrics were not collected");
        }
        const paletteRatio =
          palette50.seen.p50 > 0 ? palette500.seen.p50 / palette50.seen.p50 : Number.NaN;
        console.log(
          `PALETTE_RATIO n50=${palette50.seen.n} n500=${palette500.seen.n} p50_50=${palette50.seen.p50.toFixed(1)}ms p50_500=${palette500.seen.p50.toFixed(1)}ms ratio=${paletteRatio.toFixed(3)}`,
        );
        assertGuard(summary);
      },
    );
  });
}
