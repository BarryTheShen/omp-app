import type { BtwRecordEvent, ChatEvent, ChatHostCommand } from "@omp-app/contracts/chat-host";

/** A side question's topic as omp keeps it: its first question and answer, and its follow-ups. */
export type BtwRecord = BtwRecordEvent["record"];
/** One question of a topic and its answer (omp's `BtwHistoryTurn`). */
export type BtwTurn = Pick<
  BtwRecord,
  "question" | "answer" | "status" | "createdAt" | "updatedAt" | "error"
>;

/** omp's `getBtwLatestTurn`: the turn a topic shows last. */
export const latestTurn = (record: BtwRecord): BtwTurn => record.followUps?.at(-1) ?? record;

/** omp's `getBtwTurns`: the first turn, then the follow-ups. */
export const turnsOf = (record: BtwRecord): readonly BtwTurn[] => [
  record,
  ...(record.followUps ?? []),
];

/** omp's `getBtwCopyText`: the newest answer that is not blank, with its own whitespace; undefined when none is. */
export function copyText(record: BtwRecord): string | undefined {
  const turns = turnsOf(record);
  for (let index = turns.length - 1; index >= 0; index--) {
    const answer = turns[index]?.answer ?? "";
    if (answer.trim()) return answer;
  }
  return undefined;
}

/** omp's `patchLatestBtwTurn`. */
function patchLatest(record: BtwRecord, patch: Partial<BtwTurn>): BtwRecord {
  const followUps = record.followUps;
  const last = followUps?.at(-1);
  if (followUps !== undefined && last !== undefined) {
    return { ...record, followUps: [...followUps.slice(0, -1), { ...last, ...patch }] };
  }
  return { ...record, ...patch };
}

/** Newest first, as omp's history sorts them. */
const byNewest = (a: BtwRecord, b: BtwRecord): number =>
  b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/**
 * `/btw` typed in the message box, read as omp reads it: the question after the command (empty for `/btw` alone, which
 * opens the history), or null for any other text.
 */
export function btwQuestion(text: string): string | null {
  const match = /^\/btw(?:\s([\s\S]*))?$/.exec(text.trim());
  return match === null ? null : (match[1] ?? "").trim();
}

/** omp's `/btw`, in omp's words. omp lists it for its terminal only; the app runs it, so its menus offer it. */
export const BTW_COMMAND: ChatHostCommand = {
  name: "btw",
  description: "Ask a side question, or browse this session's BTW history",
  input: { hint: "[question]" },
  source: "builtin",
};

/** omp's commands with `/btw` after its built-in ones, unless omp lists it itself. */
export function withBtwCommand(commands: readonly ChatHostCommand[]): readonly ChatHostCommand[] {
  if (commands.some((command) => command.name === BTW_COMMAND.name)) return commands;
  const firstOther = commands.findIndex((command) => command.source !== "builtin");
  const at = firstOther === -1 ? commands.length : firstOther;
  return [...commands.slice(0, at), BTW_COMMAND, ...commands.slice(at)];
}

/** omp's words when the BTW history is put away while an answer of this pane's still comes, as Tern says them. */
export const STILL_ANSWERING = "/btw is still answering in the background · /btw to reopen it";
/** omp's words when such an answer ends while the BTW history is put away. */
export const ANSWER_READY = "/btw answer ready · /btw to read it";

export interface BtwSnapshot {
  /** The chat's side questions, newest first; null until they are read. */
  readonly records: readonly BtwRecord[] | null;
  /** The topic the BTW history shows; null for the newest. */
  readonly selected: string | null;
  /** Counts the chat's moves to another session: the BTW history reads that session's side questions. */
  readonly session: number;
  /** `/btw` asked for the side questions: the panel brings them forward, then says so (`revealed`). */
  readonly wanted: boolean;
}

/**
 * A chat pane's side questions (omp's `/btw`), shown on the Questions panel's Side questions tab (omp's BTW history).
 * Their answers stream into this store, not into the chat's: a piece of a side answer redraws that tab only.
 */
export class BtwStore {
  #records: readonly BtwRecord[] | null = null;
  #selected: string | null = null;
  #session = 0;
  /** Whether the BTW history shows this chat's side questions now. */
  #shown = false;
  /** `/btw` asked for the side questions, and the panel has not brought them forward yet. */
  #wanted = false;
  /** Topics asked from this pane: an answer of theirs that ends while the history is put away is said, as omp does. */
  readonly #asked = new Set<string>();
  #snapshot: BtwSnapshot = { records: null, selected: null, session: 0, wanted: false };
  readonly #listeners = new Set<() => void>();
  readonly #say: (text: string) => void;

  /** `say` shows one of omp's status lines in the chat. */
  constructor(say: (text: string) => void) {
    this.#say = say;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): BtwSnapshot => this.#snapshot;

  /** Takes omp's `/btw` events; false for any other event. */
  apply(event: ChatEvent): boolean {
    if (event.type === "btw_delta") {
      this.#append(event.recordId, event.delta);
      return true;
    }
    if (event.type === "btw_record") {
      this.put(event.record);
      return true;
    }
    return false;
  }

  /** The chat's side questions as omp read them: they replace what was kept. */
  setRecords(records: readonly BtwRecord[]): void {
    this.#records = [...records].sort(byNewest);
    this.#publish();
  }

  /**
   * A topic as omp sent it: it started or ended. An answer asked here that ends while the BTW history is put away is
   * said, in omp's words.
   */
  put(record: BtwRecord): void {
    const records = this.#records ?? [];
    const known = records.findIndex((kept) => kept.id === record.id);
    const wasRunning = known !== -1 && latestTurn(records[known] as BtwRecord).status === "running";
    this.#records =
      known === -1
        ? [record, ...records].sort(byNewest)
        : records.map((kept, index) => (index === known ? record : kept));
    if (
      wasRunning &&
      latestTurn(record).status === "complete" &&
      !this.#shown &&
      this.#asked.has(record.id)
    )
      this.#say(ANSWER_READY);
    this.#publish();
  }

  /**
   * A topic this pane asked (omp's answer to `btw`). omp sends its `btw_record` before that answer, and pieces of the
   * answer may already have come, so the record is kept from here only when its events have not brought this turn.
   */
  asked(record: BtwRecord): void {
    this.#asked.add(record.id);
    const kept = (this.#records ?? []).find((known) => known.id === record.id);
    if (kept !== undefined && turnsOf(kept).length >= turnsOf(record).length) return;
    this.put(record);
  }

  /** The BTW history shows topic `id`. */
  select(id: string): void {
    this.#selected = id;
    this.#publish();
  }

  /**
   * omp's `/btw`: the panel brings the side questions forward, on topic `id` when one was just asked, also while
   * questions wait for the person on its other tab.
   */
  reveal(id?: string): void {
    if (id !== undefined) this.#selected = id;
    this.#wanted = true;
    this.#publish();
  }

  /** The panel brought the side questions forward. */
  revealed(): void {
    if (!this.#wanted) return;
    this.#wanted = false;
    this.#publish();
  }

  /**
   * The BTW history shows this chat's side questions, or no longer does (the panel closed, or another tab or another
   * pane's chat took it): an answer of this pane's still coming goes on, and omp's words say so.
   */
  setShown(shown: boolean): void {
    if (this.#shown === shown) return;
    this.#shown = shown;
    if (shown) return;
    const running = (this.#records ?? []).some(
      (record) => this.#asked.has(record.id) && latestTurn(record).status === "running",
    );
    if (running) this.#say(STILL_ANSWERING);
  }

  /** The chat moved to another session (a new chat, a branch, a fork): its side questions are that session's. */
  reset(): void {
    this.#records = null;
    this.#selected = null;
    this.#asked.clear();
    this.#session += 1;
    this.#publish();
  }

  #append(id: string, delta: string): void {
    const records = this.#records;
    if (records === null) return;
    const index = records.findIndex((record) => record.id === id);
    const record = records[index];
    if (record === undefined) return;
    const latest = latestTurn(record);
    if (latest.status !== "running") return;
    const next = patchLatest(record, { answer: latest.answer + delta, updatedAt: Date.now() });
    this.#records = records.map((kept, at) => (at === index ? next : kept));
    this.#publish();
  }

  #publish(): void {
    this.#snapshot = {
      records: this.#records,
      selected: this.#selected,
      session: this.#session,
      wanted: this.#wanted,
    };
    for (const listener of [...this.#listeners]) listener();
  }
}
