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

/** omp's words when the sheet is put away while an answer of this pane's still comes, as Tern says them. */
export const STILL_ANSWERING = "/btw is still answering in the background · /btw to reopen it";
/** omp's words when such an answer ends while the sheet is put away. */
export const ANSWER_READY = "/btw answer ready · /btw to read it";

export interface BtwSnapshot {
  /** The chat's side questions, newest first; null until they are read. */
  readonly records: readonly BtwRecord[] | null;
  /** Whether the BTW history sheet is open. */
  readonly open: boolean;
  /** The topic the sheet shows; null for the newest. */
  readonly selected: string | null;
  /** Counts the chat's moves to another session: the sheet reads that session's side questions. */
  readonly session: number;
}

/**
 * A chat pane's side questions (omp's `/btw`) and their sheet. Their answers stream into this store, not into the
 * chat's: a piece of a side answer redraws the sheet only.
 */
export class BtwStore {
  #records: readonly BtwRecord[] | null = null;
  #open = false;
  #selected: string | null = null;
  #session = 0;
  /** Topics asked from this pane: an answer of theirs that ends while the sheet is put away is said, as omp does. */
  readonly #asked = new Set<string>();
  #snapshot: BtwSnapshot = { records: null, open: false, selected: null, session: 0 };
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
   * A topic as omp sent it: it started or ended. An answer asked here that ends while the sheet is put away is said, in
   * omp's words.
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
      !this.#open &&
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

  /** Opens the sheet, on topic `selected` when given (else where it was, or the newest). */
  show(selected?: string): void {
    this.#open = true;
    if (selected !== undefined) this.#selected = selected;
    this.#publish();
  }

  /** Shows topic `id` in the open sheet. */
  select(id: string): void {
    this.#selected = id;
    this.#publish();
  }

  /** Puts the sheet away; an answer of this pane's still coming goes on, and omp's words say so. */
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    const running = (this.#records ?? []).some(
      (record) => this.#asked.has(record.id) && latestTurn(record).status === "running",
    );
    if (running) this.#say(STILL_ANSWERING);
    this.#publish();
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
      open: this.#open,
      selected: this.#selected,
      session: this.#session,
    };
    for (const listener of [...this.#listeners]) listener();
  }
}
