import type { ThreadId, WorkBriefing, WorkThreadSummary } from "@omp-app/contracts";
import type { WorkThreadStore } from "./store";

/** The hour of the day the briefing is written, in the server's own time. */
export const BRIEFING_HOUR = 9;
const DAY_MS = 86_400_000;

/** The next `hour`:00 in the server's own time strictly after `now` (epoch ms); daylight saving is the clock's. */
export function nextBriefingAt(now: number, hour: number = BRIEFING_HOUR): number {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** The latest `hour`:00 at or before `now`, in the server's own time. */
export function lastBriefingAt(now: number, hour: number = BRIEFING_HOUR): number {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() > now) at.setDate(at.getDate() - 1);
  return at.getTime();
}

const waitsOnYou = (thread: WorkThreadSummary): boolean =>
  thread.unanswered > 0 || thread.state === "waiting";

const STATE_WORDS: Record<WorkThreadSummary["state"], string> = {
  open: "open",
  in_progress: "in progress",
  waiting: "waiting on you",
  done: "done",
  closed: "closed",
};

/** A chat's name as the chat list shows it; null before omp named it. */
export type ChatTitleOf = (threadId: ThreadId) => Promise<string | null>;

/** A thread as a line of the briefing: its title, its chat, state, bar, and its latest words. */
function line(thread: WorkThreadSummary, chats: ReadonlyMap<ThreadId, string>): string {
  const chat = thread.owner === null ? "" : ` in ${chats.get(thread.owner) ?? "a chat"}`;
  const bar = thread.progress === null ? "" : `, ${thread.progress.done}/${thread.progress.total}`;
  const asks = thread.unanswered > 0 ? `, ${thread.unanswered} question(s) for you` : "";
  const last = thread.last === null ? "" : `: ${thread.last.text}`;
  return `- **${thread.title}**${chat} (${STATE_WORDS[thread.state]}${bar}${asks})${last}`;
}

/**
 * Writes the day's briefing over every chat's threads, for the dashboard: the threads that moved in the 24 hours before
 * `now`, those waiting on you, and those in progress, each with its chat's name. Nothing when the day's is written
 * already (a restart after 09:00), so a day has one. Answers it, or null when there was nothing to write.
 */
export async function writeBriefing(
  store: WorkThreadStore,
  now: number,
  titleOf?: ChatTitleOf,
): Promise<WorkBriefing | null> {
  const kept = store.briefing();
  if (kept !== null && kept.at >= lastBriefingAt(now)) return null;
  // Briefing threads are from the releases that wrote the briefing into a thread.
  const threads = store.list().filter((summary) => summary.kind !== "briefing");
  const owners = [
    ...new Set(threads.flatMap((thread) => (thread.owner === null ? [] : [thread.owner]))),
  ];
  const chats = new Map<ThreadId, string>();
  if (titleOf !== undefined)
    for (const owner of owners) {
      const title = await titleOf(owner).catch(() => null);
      if (title !== null) chats.set(owner, title.slice(0, 80));
    }
  const moved = threads.filter((summary) => summary.updatedAt > now - DAY_MS);
  const waiting = threads.filter(waitsOnYou);
  const working = threads.filter((summary) => summary.state === "in_progress");
  const day = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  const part = (heading: string, list: readonly WorkThreadSummary[], none: string): string =>
    [`**${heading}**`, ...(list.length === 0 ? [none] : list.map((one) => line(one, chats)))].join(
      "\n",
    );
  const text = [
    `Briefing for ${day}.`,
    part("Moved since yesterday", moved, "Nothing moved."),
    part("Waiting on you", waiting, "Nothing waits on you."),
    part("In progress", working, "Nothing in progress."),
  ]
    .join("\n\n")
    .slice(0, 20_000);
  const briefing = { at: now, text };
  await store.setBriefing(briefing);
  return briefing;
}

export interface BriefingSchedule {
  readonly store: WorkThreadStore;
  readonly titleOf?: ChatTitleOf;
  /** Told after each briefing is written, so every device reads it. */
  readonly onWritten?: (briefing: WorkBriefing) => void;
  readonly now?: () => number;
  readonly onProblem?: (problem: string) => void;
}

/**
 * The briefing each day at 09:00, the server's time, for the dashboard. A start after the day's 09:00 with none written
 * yet writes it at once. Stops when the answer is called.
 */
export function startBriefings(schedule: BriefingSchedule): () => void {
  const now = schedule.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = async (): Promise<void> => {
    const written = await writeBriefing(schedule.store, now(), schedule.titleOf);
    if (written !== null) schedule.onWritten?.(written);
  };
  const plan = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      run()
        .catch((error: unknown) =>
          schedule.onProblem?.(error instanceof Error ? error.message : String(error)),
        )
        .finally(plan);
    }, nextBriefingAt(now()) - now());
  };
  // Today's, if the server was down at 09:00 (writeBriefing skips a day that has one).
  run()
    .catch((error: unknown) =>
      schedule.onProblem?.(error instanceof Error ? error.message : String(error)),
    )
    .finally(plan);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
