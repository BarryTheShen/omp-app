import { z } from "zod";
import type { StopOutcome } from "./background-job";

/**
 * The stops this browser saw omp confirm, one per background job (a chat and a tool call), most recent last. A stop
 * lives in the page's state, which a reload empties; without this record the card of a stopped job reads as running
 * again after the reload (issue 1471). Only the two outcomes that take the Stop control away are kept: `stopped` and
 * `finished`. A stop made in another browser, or after this browser's site data is cleared, is not in it.
 */
const STORAGE_KEY = "omp-app.stopped-background-jobs";

/** How many stops the browser keeps. Each write drops the oldest beyond this. */
export const STOPPED_JOBS_LIMIT = 200;

const Entry = z.object({
  threadId: z.string(),
  toolCallId: z.string(),
  status: z.enum(["stopped", "finished"]),
  sentence: z.string(),
});
type Entry = z.infer<typeof Entry>;

function readAll(): Entry[] {
  let raw: string | null;
  try {
    raw = globalThis.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error("[omp-app] could not read the stopped background jobs", error);
    return [];
  }
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    console.error("[omp-app] the stopped background jobs are not JSON", error);
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = Entry.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function writeAll(entries: readonly Entry[]): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.error("[omp-app] could not remember a stopped background job", error);
  }
}

/** Remembers a stop omp confirmed for one background job of one chat. Any other outcome is not kept. */
export function rememberStopped(threadId: string, toolCallId: string, outcome: StopOutcome): void {
  if (outcome.status !== "stopped" && outcome.status !== "finished") return;
  const kept = readAll().filter(
    (entry) => entry.threadId !== threadId || entry.toolCallId !== toolCallId,
  );
  const entry: Entry = { threadId, toolCallId, status: outcome.status, sentence: outcome.sentence };
  writeAll([...kept, entry].slice(-STOPPED_JOBS_LIMIT));
}

/** The stop remembered for this job of this chat, or undefined when none was confirmed. */
export function stopRememberedFor(threadId: string, toolCallId: string): StopOutcome | undefined {
  const entry = readAll().find(
    (item) => item.threadId === threadId && item.toolCallId === toolCallId,
  );
  return entry === undefined ? undefined : { status: entry.status, sentence: entry.sentence };
}

/**
 * The stop a card shows. A stop that arrived on this page always wins, and so does any fact the transcript delivers
 * or ends. Only a job the transcript still shows as running takes the remembered stop: after a reload, the page has
 * no stop, and omp keeps none in the transcript, so that running reading is the stale one the record corrects.
 */
export function resolveStopOutcome(
  live: StopOutcome | undefined,
  running: boolean,
  remembered: () => StopOutcome | undefined,
): StopOutcome | undefined {
  if (live !== undefined) return live;
  return running ? remembered() : undefined;
}
