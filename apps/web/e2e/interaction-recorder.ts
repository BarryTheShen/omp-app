import type { Page } from "@playwright/test";

const RECORDER = `(() => {
  if (window.__interactionRecorder) return;
  const state = { events: [], longFrames: [], inputs: [], states: [], mentionTimeline: [], frames: [], active: false, watch: null, previous: null, start: 0, counters: { events: 0, longFrames: 0, inputs: 0 } };
  window.__interactionRecorder = state;
  const recordEvent = (event) => state.events.push({ name: event.name, start: event.startTime, processingStart: event.processingStart, processingEnd: event.processingEnd, duration: event.duration, interactionId: event.interactionId || 0 });
  const recordLongFrame = (entry) => state.longFrames.push({ start: entry.startTime, duration: entry.duration });
  try { state.eventObserver = new PerformanceObserver((list) => list.getEntries().forEach(recordEvent)); state.eventObserver.observe({ type: "event", durationThreshold: 16 }); } catch (error) { state.eventObserverError = String(error); }
  try { state.frameObserver = new PerformanceObserver((list) => list.getEntries().forEach(recordLongFrame)); state.frameObserver.observe({ type: "long-animation-frame" }); } catch (error) { state.frameObserverError = String(error); }
  ["pointerdown", "pointerup", "click", "keydown", "beforeinput", "wheel"].forEach((name) => addEventListener(name, () => state.inputs.push({ name, time: performance.now() }), true));
  const watch = {
    menu: () => { const menu = document.querySelector('[role="menu"]'); if (!menu) return "none"; const rect = menu.getBoundingClientRect(); return rect.width > 0 ? "menu items=" + menu.querySelectorAll('[role="menuitem"]').length : "menu-0"; },
    left: () => { const sidebar = document.querySelector('[data-shell-sidebar="left"]'); const main = document.querySelector('[data-shell-main]'); return sidebar && main ? "nav=" + Math.round(sidebar.getBoundingClientRect().width) + " main=" + Math.round(main.getBoundingClientRect().width) : "x"; },
    right: () => { const sidebar = document.querySelector('[data-shell-sidebar="right"]'); const main = document.querySelector('[data-shell-main]'); return sidebar && main ? "aside=" + Math.round(sidebar.getBoundingClientRect().width) + " main=" + Math.round(main.getBoundingClientRect().width) : "x"; },
    mention: () => { const list = document.querySelector('[role="listbox"][aria-label="File suggestions"]'); if (!list) return "none"; const status = (list.textContent || "").trim().slice(0, 60); return "open opts=" + list.querySelectorAll('[role="option"]').length + " status=" + status; },
    tool: () => { const content = document.querySelector('[data-slot="u3-tool-card-content"]'); const trigger = document.querySelector('[data-slot="u3-tool-card-trigger"]'); return trigger && content ? trigger.getAttribute("aria-expanded") + " h=" + Math.round(content.getBoundingClientRect().height) : "x"; },
    search: () => { const list = document.querySelector('[role="listbox"][aria-label="Session list"]'); return list ? "rows=" + list.querySelectorAll('[role="option"]').length : "nolist"; },
    transcript: () => { const transcript = document.querySelector('[aria-label="Conversation transcript"]'); return transcript ? "scroll=" + Math.round(transcript.scrollTop) : "x"; },
    panel: () => { const selected = document.querySelector('[data-shell-sidebar="right"] [role="tab"][aria-selected="true"]'); return selected?.textContent?.trim() || "none"; },
  };
  const mentionValue = () => { const list = document.querySelector('[role="listbox"][aria-label="File suggestions"]'); if (!list) return null; return { time: performance.now(), value: watch.mention() }; };
  const mentionObserver = new MutationObserver(() => { if (!state.active) return; const current = mentionValue(); if (current && state.mentionTimeline.at(-1)?.value !== current.value) state.mentionTimeline.push(current); });
  mentionObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  const frame = (time) => { if (state.active) { state.frames.push(time); if (state.watch && watch[state.watch]) { let value; try { value = watch[state.watch](); } catch { value = "err"; } if (value !== state.previous) { state.previous = value; state.states.push({ time, value }); } } } requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  state.begin = (key) => { state.eventObserver?.takeRecords().forEach(recordEvent); state.frameObserver?.takeRecords().forEach(recordLongFrame); state.counters = { events: state.events.length, longFrames: state.longFrames.length, inputs: state.inputs.length }; state.states = []; state.mentionTimeline = []; state.frames = []; state.watch = key || null; state.previous = null; state.active = true; state.start = performance.now(); return state.start; };
  state.end = () => { state.eventObserver?.takeRecords().forEach(recordEvent); state.frameObserver?.takeRecords().forEach(recordLongFrame); state.active = false; let maxGap = 0; for (let index = 1; index < state.frames.length; index += 1) maxGap = Math.max(maxGap, state.frames[index] - state.frames[index - 1]); return { start: state.start, end: performance.now(), events: state.events.slice(state.counters.events), longFrames: state.longFrames.slice(state.counters.longFrames), inputs: state.inputs.slice(state.counters.inputs), mentionTimeline: state.mentionTimeline, states: state.states, frameCount: state.frames.length, maxGap }; };
})()`;

export interface InteractionEvent {
  readonly name: string;
  readonly start: number;
  readonly processingStart: number;
  readonly processingEnd: number;
  readonly duration: number;
  readonly interactionId: number;
}
export interface InteractionLongFrame {
  readonly start: number;
  readonly duration: number;
}
export interface InteractionState {
  readonly time: number;
  readonly value: string;
}
export interface InteractionResult {
  readonly start: number;
  readonly end: number;
  readonly events: readonly InteractionEvent[];
  readonly inputs: readonly { readonly name: string; readonly time: number }[];
  readonly longFrames: readonly InteractionLongFrame[];
  readonly mentionTimeline: readonly InteractionState[];
  readonly states: readonly InteractionState[];
  readonly frameCount: number;
  readonly maxGap: number;
  readonly error?: string;
}
export interface InteractionSummary {
  readonly handler: number;
  readonly paint: number;
  readonly firstChange: number;
  readonly longFrame: number;
  readonly attributedLongFrames: number;
  readonly maxGap: number;
  readonly content: string;
  readonly mentionTimeline: readonly InteractionState[];
  readonly contentAtMs: number;
  readonly error?: string;
}

declare global {
  interface Window {
    __interactionRecorder: { begin(key: string | null): number; end(): InteractionResult };
  }
}

export async function installInteractionRecorder(page: Page): Promise<void> {
  await page.evaluate(RECORDER);
}
export async function recordInteraction(
  page: Page,
  watch: string | null,
  action: () => Promise<void>,
  waitMs = 800,
): Promise<InteractionResult> {
  await page.evaluate((key) => window.__interactionRecorder.begin(key), watch);
  let error: string | undefined;
  try {
    await action();
  } catch (caught) {
    error = (String(caught).split("\n").at(0) ?? String(caught)).slice(0, 160);
  }
  await page.waitForTimeout(waitMs);
  const result = await page.evaluate(() => window.__interactionRecorder.end());
  return { ...result, ...(error === undefined ? {} : { error }) } as InteractionResult;
}
export function summarizeInteraction(result: InteractionResult): InteractionSummary {
  const firstInput = result.inputs[0]?.time ?? result.start;
  const firstState = result.states.find((state) => state.time >= firstInput - 5);
  const eventInputs = result.events.filter(
    (event) =>
      ["click", "keydown", "pointerup", "pointerdown", "beforeinput"].includes(event.name) &&
      event.start >= firstInput - 5 &&
      event.start <= firstInput + 300,
  );
  const frames = result.longFrames.filter(
    (frame) => frame.start >= firstInput - 40 && frame.start <= firstInput + 1_000,
  );
  const mentionTimeline = result.mentionTimeline
    .filter((state) => state.time >= firstInput - 5)
    .map((state) => ({ time: state.time - firstInput, value: state.value }));
  return {
    handler: Math.max(0, ...eventInputs.map((event) => event.processingEnd - event.start)),
    paint: Math.max(0, ...eventInputs.map((event) => event.duration)),
    firstChange: firstState === undefined ? result.end - firstInput : firstState.time - firstInput,
    longFrame: Math.max(0, ...frames.map((frame) => frame.duration)),
    attributedLongFrames: frames.length,
    maxGap: result.maxGap,
    content: firstState?.value ?? "none",
    mentionTimeline,
    contentAtMs: firstState === undefined ? -1 : firstState.time - firstInput,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}
export function max(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
