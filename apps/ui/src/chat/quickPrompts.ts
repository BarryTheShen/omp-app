import { useSyncExternalStore } from "react";

/** The prompts a phone's quick panel starts with: short answers that keep omp going. */
export const STARTING_PROMPTS: readonly string[] = [
  "Continue",
  "Sure",
  "Yes",
  "No",
  "Idk, need to think about this",
  "Explain that",
  "Go ahead",
  "Stop and sum up",
];

/** At most this many prompts, each at most this long: the panel is a tap list, not a store of messages. */
export const MOST_PROMPTS = 40;
export const LONGEST_PROMPT = 500;

const KEY = "omp-app.ui.quick-prompts";
const listeners = new Set<() => void>();

/** One prompt a line, as typed or as kept: trimmed, empty lines and repeats dropped, within the limits. */
export function promptsFrom(lines: readonly unknown[]): readonly string[] {
  const kept: string[] = [];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const prompt = line.trim().slice(0, LONGEST_PROMPT);
    if (prompt !== "" && !kept.includes(prompt)) kept.push(prompt);
    if (kept.length === MOST_PROMPTS) break;
  }
  return kept;
}

/** What this device keeps; the starting set when nothing, or nothing readable, is kept. */
function read(): readonly string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!Array.isArray(kept)) return STARTING_PROMPTS;
    const prompts = promptsFrom(kept);
    return prompts.length === 0 ? STARTING_PROMPTS : prompts;
  } catch {
    return STARTING_PROMPTS;
  }
}

let current: readonly string[] | null = null;

function snapshot(): readonly string[] {
  current ??= read();
  return current;
}

function changed(): void {
  current = null;
  for (const listener of listeners) listener();
}

/** Keeps these prompts on this device; null goes back to the starting set. */
export function setQuickPrompts(prompts: readonly string[] | null): void {
  const kept = prompts === null ? [] : promptsFrom(prompts);
  if (kept.length === 0) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(kept));
  changed();
}

/** The quick panel's prompts on this device, following changes made here or in another window. */
export function useQuickPrompts(): readonly string[] {
  return useSyncExternalStore((notify) => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === KEY || event.key === null) changed();
    };
    listeners.add(notify);
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(notify);
      window.removeEventListener("storage", onStorage);
    };
  }, snapshot);
}
