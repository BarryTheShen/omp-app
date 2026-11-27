import type { ThreadId, WorkThreadSummary } from "@omp-app/contracts";
import type { WorkThreadStore } from "./store";

/** The hour of the day the briefing is written, in the server's own time. */
export const BRIEFING_HOUR = 9;
const DAY_MS = 86_400_000;
const APP = { kind: "app" } as const;

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

/** A thread as a line of the briefing: its title, state, bar, and its latest words. */
function line(thread: WorkThreadSummary): string {
  const bar = thread.progress === null ? "" : `, ${thread.progress.done}/${thread.progress.total}`;
  const asks = thread.unanswered > 0 ? `, ${thread.unanswered} question(s) for you` : "";
  const last = thread.last === null ? "" : `: ${thread.last.text}`;
  return `- **${thread.title}** (${STATE_WORDS[thread.state]}${bar}${asks})${last}`;
}

/** The briefing thread, open: the one kept, else a new one owned by the main chat. */
async function briefingThread(store: WorkThreadStore): Promise<WorkThreadSummary> {
  const kept = store
    .list()
    .find((thread) => thread.kind === "briefing" && thread.state !== "closed");
  if (kept !== undefined) return kept;
  return store.open(
    {
      title: "Daily briefing",
      kind: "briefing",
      text: "One entry each morning: what moved since the day before, what waits on you, and what is in progress.",
      owner: store.mainChat(),
    },
    APP,
  );
}

/**
 * Writes the day's briefing into the briefing thread, as the app: the threads that moved in the 24 hours before `now`,
 * those waiting on you, and those in progress. Nothing when the day's entry is there already (a restart after 09:00),
 * so a day has one. Answers the thread and its words, or null when there was nothing to write.
 */
export async function writeBriefing(
  store: WorkThreadStore,
  now: number,
): Promise<{ readonly thread: WorkThreadSummary; readonly text: string } | null> {
  const thread = await briefingThread(store);
  const since = lastBriefingAt(now);
  const written = store
    .read(thread.id)
    ?.entries.some(
      (entry) => entry.type === "update" && entry.by.kind === "app" && entry.at >= since,
    );
  if (written === true) return null;
  const others = store.list().filter((summary) => summary.id !== thread.id);
  const moved = others.filter((summary) => summary.updatedAt > now - DAY_MS);
  const waiting = others.filter(waitsOnYou);
  const working = others.filter((summary) => summary.state === "in_progress");
  const day = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  const part = (heading: string, threads: readonly WorkThreadSummary[], none: string): string =>
    [`**${heading}**`, ...(threads.length === 0 ? [none] : threads.map(line))].join("\n");
  const text = [
    `Briefing for ${day}.`,
    part("Moved since yesterday", moved, "Nothing moved."),
    part("Waiting on you", waiting, "Nothing waits on you."),
    part("In progress", working, "Nothing in progress."),
  ].join("\n\n");
  const posted = await store.post(thread.id, { type: "update", text }, APP);
  return { thread: posted.summary, text };
}

export interface BriefingSchedule {
  readonly store: WorkThreadStore;
  /** Asks the main chat to add what is next, once it is free (the task queue). */
  readonly askMainChat: (threadId: ThreadId, text: string) => Promise<void>;
  readonly now?: () => number;
  readonly onProblem?: (problem: string) => void;
}

/** The notice that asks the main chat to add to the day's entry. */
export const briefingNotice = (thread: WorkThreadSummary): string =>
  `Thread ${thread.id} "${thread.title}": today's briefing is written there. Read it (thread_read), then add what is next for each thread in progress and what you need from the person, with thread_update in that thread.`;

/**
 * The briefing each day at 09:00, the server's time: written into the briefing thread, then the main chat is asked to
 * add what is next. A start after the day's 09:00 with no entry yet writes it at once. Stops when the answer is called.
 */
export function startBriefings(schedule: BriefingSchedule): () => void {
  const now = schedule.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = async (): Promise<void> => {
    const written = await writeBriefing(schedule.store, now());
    const main = schedule.store.mainChat();
    if (written !== null && main !== null)
      await schedule.askMainChat(main, briefingNotice(written.thread));
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
