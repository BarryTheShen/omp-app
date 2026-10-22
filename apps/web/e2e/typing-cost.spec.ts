/**
 * What one keystroke costs in the composer (#2269, `.data/perf/plan-typing.md`, section 4, T0). A seeded chat of
 * `TYPING_MESSAGES` messages is opened and settled; then `TYPING_KEYS` lowercase keys are sent to the focused composer one
 * at a time with `page.keyboard.press`, `TYPING_GAP_MS` apart on an absolute schedule. A locator action would resolve the
 * composer by role inside the measured window (Playwright work in the task), so none is used. Around each key the browser's
 * counters are read over CDP (`Performance.getMetrics`): the change from the keydown to the second animation frame after it.
 * The page's own record (`typing-recorder.ts`) adds the handler times, React commits, long tasks and, in the census build
 * (`TYPING_CENSUS=1`), the renders and layout reads. Everything is printed as `TYP*` lines; the test-machine job sets the sizes,
 * the load label (`TYPING_LOAD`, the job itself starts any load) and the run count (`--repeat-each`).
 *
 * The count gates are p50 per key over one run, and they are deterministic, so they hold under load. T0 holds main's
 * values (layout runs 6, style recalcs 6, React commits 4): this spec is green on main. Each later step lowers its gate.
 */
import { readFileSync } from "node:fs";
import type { CDPSession } from "@playwright/test";
import { settleTranscript } from "./motion-audit-recorder";
import { expect, realTest, waitForFiniteAnimations } from "./real-omp";
import {
  readTypingLog,
  recordTyping,
  type SerializedTypingKey,
  settleTyping,
  type TypingSpan,
  typingChat,
} from "./typing-recorder";

const MESSAGES = Number(process.env.TYPING_MESSAGES ?? 50);
const KEYS = Number(process.env.TYPING_KEYS ?? 40);
const GAP_MS = Number(process.env.TYPING_GAP_MS ?? 120);
const LOAD = process.env.TYPING_LOAD ?? "quiet";
const CENSUS = process.env.TYPING_CENSUS === "1";
const PROFILE = process.env.TYPING_PROFILE === "1";
/** Lowercase letters and spaces only: no `/ @ # :`, so no trigger text appears in the composer. */
const TEXT = process.env.TYPING_TEXT ?? "abcdefghij klmnopqrs tuvwxyz abcdefghij klmnopqrs";

/** The count gates: the p50 per key of a run must be at or under these. T0 holds main's values. */
const GATES = { layoutRuns: 6, styleRecalcs: 6, commits: 4 } as const;

/** The browser's counters for one key, as the change over its window (times in ms). */
interface Counters {
  readonly task: number;
  readonly script: number;
  readonly style: number;
  readonly layout: number;
  readonly layouts: number;
  readonly recalcs: number;
}

interface Sample extends Counters {
  readonly run: number;
  readonly key: number;
  readonly commits: number;
  /** Keydown handler and input handler, from window capture to window bubble. */
  readonly hkd: number;
  readonly hin: number;
  /** Keydown to the first animation frame, and to the last commit of the key. */
  readonly fr1: number;
  readonly lastCommit: number;
  /** Long tasks and long animation frames that overlap the key's window. */
  readonly longTasks: number;
  readonly frames: number;
  readonly renders: Record<string, number>;
  readonly reads: Record<string, number>;
}

/** The numeric fields of a sample: each is summarised as p50 and worst over the keys. */
const NUMBER_FIELDS = [
  "task",
  "script",
  "style",
  "layout",
  "layouts",
  "recalcs",
  "commits",
  "hkd",
  "hin",
  "fr1",
  "lastCommit",
  "longTasks",
  "frames",
] as const;
const INCLUSIVE_NAMES = ["useAuiState", "getSnapshot", "resizeTextarea", "flushTapSync"];

const pooled: Sample[] = [];

realTest.use({ seedEntries: { entries: typingChat(MESSAGES) } });

async function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function readCounters(session: CDPSession): Promise<Map<string, number>> {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await session.send("Performance.getMetrics");
  return new Map(result.metrics.map((metric): [string, number] => [metric.name, metric.value]));
}

function countersOf(before: Map<string, number>, after: Map<string, number>): Counters {
  const change = (name: string): number => (after.get(name) ?? 0) - (before.get(name) ?? 0);
  return {
    task: change("TaskDuration") * 1000,
    script: change("ScriptDuration") * 1000,
    style: change("RecalcStyleDuration") * 1000,
    layout: change("LayoutDuration") * 1000,
    layouts: change("LayoutCount"),
    recalcs: change("RecalcStyleCount"),
  };
}

/** The median: the middle value, or the mean of the two middle values when the count is even. */
function p50(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? 0) + upper) / 2;
}

const ms = (value: number): string => value.toFixed(1);

function sampleOf(
  run: number,
  index: number,
  key: SerializedTypingKey,
  counters: Counters,
  spans: { readonly longTasks: readonly TypingSpan[]; readonly frames: readonly TypingSpan[] },
): Sample {
  const overlaps = (span: TypingSpan): boolean =>
    span.start < key.end && span.start + span.duration > key.at;
  return {
    ...counters,
    run,
    key: index,
    commits: key.commits,
    hkd: key.hkd,
    hin: key.hin,
    fr1: key.fr1,
    lastCommit: key.lastCommit,
    longTasks: spans.longTasks.filter(overlaps).length,
    frames: spans.frames.filter(overlaps).length,
    renders: key.renders,
    reads: key.reads,
  };
}

function keyLine(sample: Sample): string {
  return [
    `TYPKEY load=${LOAD} msgs=${MESSAGES} r=${sample.run} k=${sample.key}`,
    `task=${ms(sample.task)} script=${ms(sample.script)} style=${ms(sample.style)} layout=${ms(sample.layout)}`,
    `lay=${sample.layouts} sty=${sample.recalcs} cm=${sample.commits}`,
    `hkd=${ms(sample.hkd)} hin=${ms(sample.hin)} fr1=${ms(sample.fr1)} lc=${ms(sample.lastCommit)}`,
    `lt=${sample.longTasks} loaf=${sample.frames}`,
  ].join(" ");
}

/** The census of the pooled keys: renders per component and layout reads per call site, as p50 and worst. */
function censusLines(samples: readonly Sample[]): string[] {
  const lines: string[] = [];
  const table = (kind: "TYPCEN" | "TYPREAD", field: "renders" | "reads"): void => {
    const names = new Set(samples.flatMap((sample) => Object.keys(sample[field])));
    for (const name of [...names].sort()) {
      const values = samples.map((sample) => sample[field][name] ?? 0);
      lines.push(
        `${kind} load=${LOAD} msgs=${MESSAGES} ${name} p50=${p50(values)} worst=${Math.max(...values)} keys=${values.length}`,
      );
    }
  };
  table("TYPCEN", "renders");
  table("TYPREAD", "reads");
  return lines;
}

/** The summary of the pooled keys: p50 and worst per field. */
function summaryLines(samples: readonly Sample[]): string[] {
  return NUMBER_FIELDS.map((field) => {
    const values = samples.map((sample) => sample[field]);
    return `TYPSUM load=${LOAD} msgs=${MESSAGES} ${field} p50=${ms(p50(values))} worst=${ms(Math.max(...values))} keys=${values.length}`;
  });
}

/** The CPU profile's self and inclusive time, by function name (approximate: a sample lasts until the next one). */
interface CpuProfile {
  readonly nodes: Array<{
    readonly id: number;
    readonly callFrame: { readonly functionName: string };
    readonly children?: number[];
  }>;
  readonly samples?: number[];
  readonly timeDeltas?: number[];
}

function profileLines(profile: CpuProfile): string[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node] as const));
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }
  const nameOf = (id: number): string => nodes.get(id)?.callFrame.functionName || "(anonymous)";
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  (profile.samples ?? []).forEach((id, index) => {
    const duration = ((profile.timeDeltas ?? [])[index + 1] ?? 0) / 1000;
    self.set(nameOf(id), (self.get(nameOf(id)) ?? 0) + duration);
    const onStack = new Set<string>();
    for (let node: number | undefined = id; node !== undefined; node = parentOf.get(node)) {
      const name = nameOf(node);
      if (onStack.has(name)) continue;
      onStack.add(name);
      inclusive.set(name, (inclusive.get(name) ?? 0) + duration);
    }
  });
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30);
  return [
    ...top.map(([name, value]) => `TYPPROF self ${ms(value)} ms ${name}`),
    ...INCLUSIVE_NAMES.map((name) => `TYPPROF incl ${ms(inclusive.get(name) ?? 0)} ms ${name}`),
  ];
}

realTest.describe("a keystroke in the composer", () => {
  realTest.afterAll(() => {
    if (pooled.length === 0) return;
    for (const line of [...summaryLines(pooled), ...censusLines(pooled)]) console.log(line);
  });

  realTest(
    "each key's cost is measured and the count gates hold",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const run = testInfo.repeatEachIndex;
      const started = Date.now();
      const loadBefore = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join("/");
      const page = await realApp.open({
        beforeLoad: (target) => target.addInitScript(recordTyping, { census: CENSUS }),
      });
      await page
        .getByRole("listbox", { name: "Session list" })
        .getByRole("option")
        .filter({ hasText: "Question 1" })
        .click();
      await expect(page.getByText(`Answer ${MESSAGES / 2}.`)).toBeVisible({ timeout: 120_000 });
      await settleTranscript(page);
      await waitForFiniteAnimations(page);
      const composer = page.getByRole("textbox", { name: "Message input" });
      await composer.click();
      await expect(composer).toBeFocused();

      const session = await page.context().newCDPSession(page);
      await session.send("Performance.enable");
      if (PROFILE) {
        await session.send("Profiler.enable");
        await session.send("Profiler.setSamplingInterval", { interval: 100 });
        await session.send("Profiler.start");
      }
      const firstKey = (await readTypingLog(page)).keys.length;
      const typed = Array.from({ length: KEYS }, (_, index) => TEXT.charAt(index % TEXT.length));
      const pairs: Array<{ before: Map<string, number>; after: Map<string, number> }> = [];
      const schedule = Date.now();
      for (const [index, letter] of typed.entries()) {
        const due = schedule + index * GAP_MS;
        const wait = due - Date.now();
        if (wait > 0) await delay(wait);
        const before = await readCounters(session);
        // The key goes to the focused composer through the page's keyboard (see the header): no locator is resolved here.
        await page.keyboard.press(letter);
        await settleTyping(page);
        pairs.push({ before, after: await readCounters(session) });
      }
      await delay(600);
      await expect(composer, "the composer holds every typed character").toHaveValue(
        typed.join(""),
      );

      const stopped = PROFILE ? await session.send("Profiler.stop") : undefined;
      const log = await readTypingLog(page);
      const keys = log.keys.slice(firstKey);
      expect(keys.length, "one keydown per typed key").toBe(KEYS);
      expect(
        keys.every((key) => key.end >= 0),
        "every key reached its second animation frame",
      ).toBe(true);

      const samples = keys.map((key, index) => {
        const pair = pairs[index];
        if (pair === undefined) throw new Error(`no counters for key ${index}`);
        const counters = countersOf(pair.before, pair.after);
        return sampleOf(run, index, key, counters, log);
      });
      pooled.push(...samples);

      const layoutRuns = p50(samples.map((sample) => sample.layouts));
      const styleRecalcs = p50(samples.map((sample) => sample.recalcs));
      const commits = p50(samples.map((sample) => sample.commits));
      const loadAfter = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join("/");
      for (const sample of samples) console.log(keyLine(sample));
      console.log(
        [
          `TYPRUN load=${LOAD} msgs=${MESSAGES} r=${run} keys=${samples.length} val=ok`,
          `p50 task=${ms(p50(samples.map((s) => s.task)))} layouts=${layoutRuns} recalcs=${styleRecalcs} commits=${commits}`,
          `loadavg=${loadBefore}>${loadAfter} wallMs=${Date.now() - started}`,
        ].join(" "),
      );
      if (stopped !== undefined)
        for (const line of profileLines(stopped.profile)) console.log(line);

      expect(layoutRuns, `layout runs per key, p50 (gate ${GATES.layoutRuns})`).toBeLessThanOrEqual(
        GATES.layoutRuns,
      );
      expect(
        styleRecalcs,
        `style recalcs per key, p50 (gate ${GATES.styleRecalcs})`,
      ).toBeLessThanOrEqual(GATES.styleRecalcs);
      expect(commits, `React commits per key, p50 (gate ${GATES.commits})`).toBeLessThanOrEqual(
        GATES.commits,
      );
    },
  );
});
