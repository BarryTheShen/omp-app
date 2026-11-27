import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type OpenWorkThreadArgs,
  ThreadId,
  WorkBriefing,
  type WorkThreadAnswer,
  type WorkThreadAuthor,
  WorkThreadEntry,
  WorkThreadId,
  type WorkThreadPost,
  type WorkThreadQuestion,
  type WorkThreadSummary,
} from "@omp-app/contracts";
import { z } from "zod";
import { writeFileAtomic } from "../modules/A1/fs";

const FOLDER = "threads";
const SUFFIX = ".jsonl";
/** The main chat, beside the threads' files (not a `.jsonl`, so never read as a thread). */
const SETTINGS = "settings.json";
const Settings = z.object({ mainChat: ThreadId.nullable() });
/** The day's briefing, beside them too. */
const BRIEFING = "briefing.json";
/** How much of the latest words a row shows. */
const LAST_TEXT_MAX = 160;

/** A change a thread cannot take, in words for the person or the agent who asked. */
export class WorkThreadRefused extends Error {}

export type WorkThreadListener = (summary: WorkThreadSummary) => void;

export interface WorkThreadStoreOptions {
  readonly now?: () => number;
  /** A new thread's id; by default its time and a random tail, in base 36. */
  readonly newId?: () => string;
}

/** A thread's whole timeline, as its file has it. */
export interface WorkThreadRead {
  readonly summary: WorkThreadSummary;
  readonly entries: readonly WorkThreadEntry[];
}

/** One ask of a thread: its questions, the latest answer to each, and those already handed to the chat. */
interface Ask {
  readonly questions: ReadonlyMap<string, WorkThreadQuestion>;
  readonly answers: Map<string, WorkThreadAnswer>;
  readonly sent: Set<string>;
}

interface Kept {
  summary: WorkThreadSummary;
  readonly entries: WorkThreadEntry[];
  readonly asks: Map<string, Ask>;
}

const defaultId = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;

const cut = (text: string): string =>
  text.length <= LAST_TEXT_MAX ? text : `${text.slice(0, LAST_TEXT_MAX - 1).trimEnd()}…`;

/** The words an entry adds to the list's row, if it has any. */
function wordsOf(entry: WorkThreadEntry): string | null {
  switch (entry.type) {
    case "created":
    case "update":
    case "message":
      return entry.text;
    case "question":
      return entry.questions[0]?.question ?? null;
    default:
      return null;
  }
}

const unansweredIn = (asks: ReadonlyMap<string, Ask>): number => {
  let count = 0;
  for (const ask of asks.values()) count += ask.questions.size - ask.answers.size;
  return count;
};

/** The thread after one more entry: its summary and asks follow; the entry is assumed checked (`#check`). */
function fold(kept: Kept, entry: WorkThreadEntry): void {
  kept.entries.push(entry);
  const summary = { ...kept.summary, updatedAt: Math.max(kept.summary.updatedAt, entry.at) };
  switch (entry.type) {
    case "created":
      break;
    case "update":
      if (entry.progress !== undefined) summary.progress = entry.progress;
      break;
    case "progress":
      summary.progress = entry.progress;
      break;
    case "question":
      kept.asks.set(entry.id, {
        questions: new Map(entry.questions.map((question) => [question.id, question])),
        answers: new Map(),
        sent: new Set(),
      });
      break;
    case "answer":
      kept.asks.get(entry.ask)?.answers.set(entry.questionId, entry.answer);
      break;
    case "sent": {
      const ask = kept.asks.get(entry.ask);
      for (const questionId of entry.questionIds) ask?.sent.add(questionId);
      break;
    }
    case "message":
      break;
    case "link": {
      const key = JSON.stringify(entry.link);
      if (!summary.links.some((link) => JSON.stringify(link) === key))
        summary.links = [...summary.links, entry.link];
      break;
    }
    case "state":
      summary.state = entry.state;
      break;
    case "owner":
      summary.owner = entry.owner;
      break;
  }
  const words = wordsOf(entry);
  if (words !== null) summary.last = { type: entry.type, text: cut(words), at: entry.at };
  summary.unanswered = unansweredIn(kept.asks);
  summary.entries = kept.entries.length;
  kept.summary = summary;
}

/** A thread from its first entry, which must be `created`. */
function started(id: WorkThreadId, entry: WorkThreadEntry & { type: "created" }): Kept {
  const kept: Kept = {
    summary: {
      id,
      title: entry.title,
      kind: entry.kind,
      state: "open",
      owner: entry.owner,
      createdAt: entry.at,
      createdBy: entry.by,
      updatedAt: entry.at,
      progress: null,
      unanswered: 0,
      links: [],
      last: null,
      entries: 0,
    },
    entries: [],
    asks: new Map(),
  };
  fold(kept, entry);
  return kept;
}

/**
 * Workbench threads (`<app data>/threads/<id>.jsonl`): each thread a file of entries, one JSON line each, only ever
 * appended. The list is folded from the files at the start and kept in memory. Changes run one at a time: checked
 * against the thread as it is, written, and only then taken in and told to the listeners, so what they hear is on
 * disk. A last line cut short (a write the machine stopped) is dropped at the start, so the next entry starts on a line
 * of its own.
 */
export class WorkThreadStore {
  readonly folder: string;
  readonly #threads = new Map<WorkThreadId, Kept>();
  readonly #listeners = new Set<WorkThreadListener>();
  readonly #now: () => number;
  readonly #newId: () => string;
  #queue: Promise<unknown> = Promise.resolve();
  #mainChat: ThreadId | null = null;
  #briefing: WorkBriefing | null = null;

  private constructor(folder: string, options: WorkThreadStoreOptions) {
    this.folder = folder;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? defaultId;
  }

  static async open(
    appDataDir: string,
    options: WorkThreadStoreOptions = {},
  ): Promise<WorkThreadStore> {
    const folder = join(appDataDir, FOLDER);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const store = new WorkThreadStore(folder, options);
    const names = (await readdir(folder)).filter((name) => name.endsWith(SUFFIX));
    for (const name of names) {
      const id = WorkThreadId.safeParse(name.slice(0, -SUFFIX.length));
      if (!id.success) continue;
      const kept = await store.#load(id.data, join(folder, name));
      if (kept !== null) store.#threads.set(id.data, kept);
    }
    const settings = await readFile(join(folder, SETTINGS), "utf8").catch(() => null);
    if (settings !== null) {
      try {
        const parsed = Settings.safeParse(JSON.parse(settings));
        if (parsed.success) store.#mainChat = parsed.data.mainChat;
      } catch {
        // Settings it cannot read: no main chat until one is set again.
      }
    }
    const briefing = await readFile(join(folder, BRIEFING), "utf8").catch(() => null);
    if (briefing !== null) {
      try {
        const parsed = WorkBriefing.safeParse(JSON.parse(briefing));
        if (parsed.success) store.#briefing = parsed.data;
      } catch {
        // A briefing it cannot read: none until the next is written.
      }
    }
    return store;
  }

  /** The chat that takes a thread no chat owns; null: none is set. */
  mainChat(): ThreadId | null {
    return this.#mainChat;
  }

  setMainChat(threadId: ThreadId | null): Promise<void> {
    return this.#serial(async () => {
      await writeFileAtomic(
        join(this.folder, SETTINGS),
        `${JSON.stringify({ mainChat: threadId })}\n`,
      );
      this.#mainChat = threadId;
    });
  }

  /** The latest briefing; null before the first. */
  briefing(): WorkBriefing | null {
    return this.#briefing;
  }

  setBriefing(briefing: WorkBriefing): Promise<void> {
    return this.#serial(async () => {
      await writeFileAtomic(join(this.folder, BRIEFING), `${JSON.stringify(briefing)}\n`);
      this.#briefing = briefing;
    });
  }

  /** The threads, the one with the latest entry first. */
  list(): WorkThreadSummary[] {
    return [...this.#threads.values()]
      .map((kept) => kept.summary)
      .sort((left, right) => right.updatedAt - left.updatedAt || (right.id < left.id ? -1 : 1));
  }

  read(id: WorkThreadId): WorkThreadRead | null {
    const kept = this.#threads.get(id);
    return kept === undefined ? null : { summary: kept.summary, entries: [...kept.entries] };
  }

  /** An ask of a thread: its questions in the order asked, the latest answer to each, and those already sent. */
  askOf(
    id: WorkThreadId,
    ask: string,
  ): {
    readonly questions: readonly WorkThreadQuestion[];
    readonly answers: ReadonlyMap<string, WorkThreadAnswer>;
    readonly sent: ReadonlySet<string>;
  } | null {
    const found = this.#threads.get(id)?.asks.get(ask);
    if (found === undefined) return null;
    return {
      questions: [...found.questions.values()],
      answers: new Map(found.answers),
      sent: new Set(found.sent),
    };
  }

  /** Opens a thread: its file, with the `created` entry as its first line. */
  open(args: OpenWorkThreadArgs, by: WorkThreadAuthor): Promise<WorkThreadSummary> {
    return this.#serial(async () => {
      const id = WorkThreadId.parse(this.#newId());
      if (this.#threads.has(id)) throw new WorkThreadRefused(`thread ${id} exists already`);
      const entry = WorkThreadEntry.parse({
        ...args,
        id: "e1",
        at: this.#now(),
        by,
        type: "created",
      });
      await writeFile(this.#path(id), `${JSON.stringify(entry)}\n`, { flag: "wx", mode: 0o600 });
      const kept = started(id, entry as WorkThreadEntry & { type: "created" });
      this.#threads.set(id, kept);
      this.#tell(kept.summary);
      return kept.summary;
    });
  }

  /** Adds an entry to a thread, once it is checked against the thread as it is; answers the entry as written. */
  post(
    id: WorkThreadId,
    post: WorkThreadPost,
    by: WorkThreadAuthor,
  ): Promise<{ readonly summary: WorkThreadSummary; readonly entry: WorkThreadEntry }> {
    return this.#serial(async () => {
      const kept = this.#threads.get(id);
      if (kept === undefined) throw new WorkThreadRefused(`there is no thread ${id}`);
      check(kept, post);
      const entry = WorkThreadEntry.parse({
        ...post,
        id: `e${kept.entries.length + 1}`,
        at: this.#now(),
        by,
      });
      await appendFile(this.#path(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      fold(kept, entry);
      this.#tell(kept.summary);
      return { summary: kept.summary, entry };
    });
  }

  subscribe(listener: WorkThreadListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Waits for the changes so far (tests, and the server's stop). */
  settled(): Promise<unknown> {
    return this.#queue.catch(() => undefined);
  }

  #path(id: WorkThreadId): string {
    return join(this.folder, `${id}${SUFFIX}`);
  }

  #serial<T>(change: () => Promise<T>): Promise<T> {
    const run = this.#queue.catch(() => undefined).then(change);
    this.#queue = run;
    return run;
  }

  #tell(summary: WorkThreadSummary): void {
    for (const listener of [...this.#listeners]) listener(summary);
  }

  /** A thread's file folded; a last line cut short is dropped from the file; a line it cannot read is skipped. */
  async #load(id: WorkThreadId, path: string): Promise<Kept | null> {
    let text = await readFile(path, "utf8");
    if (text !== "" && !text.endsWith("\n")) {
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      await writeFileAtomic(path, text);
    }
    let kept: Kept | null = null;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: ReturnType<typeof WorkThreadEntry.safeParse>;
      try {
        parsed = WorkThreadEntry.safeParse(JSON.parse(line));
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const entry = parsed.data;
      if (kept === null) {
        if (entry.type !== "created") return null;
        kept = started(id, entry);
        continue;
      }
      if (entry.type === "created") continue;
      try {
        check(kept, entry);
      } catch {
        continue;
      }
      fold(kept, entry);
    }
    return kept;
  }
}

/** Refuses a post the thread cannot take: an answer to no question, or one already handed over, and the like. */
function check(kept: Kept, post: WorkThreadPost): void {
  switch (post.type) {
    case "question": {
      const ids = new Set<string>();
      for (const question of post.questions) {
        if (ids.has(question.id))
          throw new WorkThreadRefused(`two questions have the id "${question.id}"`);
        ids.add(question.id);
        const labels = new Set(question.options.map((option) => option.label));
        if (labels.size !== question.options.length)
          throw new WorkThreadRefused(
            `question "${question.id}" has two choices of the same label`,
          );
        if (question.recommended !== undefined && question.recommended >= question.options.length)
          throw new WorkThreadRefused(
            `question "${question.id}" recommends a choice it does not have`,
          );
      }
      return;
    }
    case "answer": {
      const ask = kept.asks.get(post.ask);
      const question = ask?.questions.get(post.questionId);
      if (ask === undefined || question === undefined)
        throw new WorkThreadRefused(`there is no question "${post.questionId}" in ${post.ask}`);
      if (ask.sent.has(post.questionId))
        throw new WorkThreadRefused(`question "${post.questionId}" was answered and sent already`);
      const labels = new Set(question.options.map((option) => option.label));
      for (const label of post.answer.picked)
        if (!labels.has(label))
          throw new WorkThreadRefused(`question "${post.questionId}" has no choice "${label}"`);
      if (!question.multi && post.answer.picked.length > 1)
        throw new WorkThreadRefused(`question "${post.questionId}" takes one choice`);
      if (post.answer.skipped && (post.answer.picked.length > 0 || post.answer.typed !== undefined))
        throw new WorkThreadRefused("a skipped question has no answer");
      if (
        !post.answer.skipped &&
        post.answer.picked.length === 0 &&
        (post.answer.typed === undefined || post.answer.typed.trim() === "")
      )
        throw new WorkThreadRefused(`the answer to "${post.questionId}" is empty`);
      return;
    }
    case "sent": {
      const ask = kept.asks.get(post.ask);
      if (ask === undefined) throw new WorkThreadRefused(`there is no ask ${post.ask}`);
      for (const questionId of post.questionIds) {
        if (!ask.answers.has(questionId))
          throw new WorkThreadRefused(`question "${questionId}" has no answer to send`);
        if (ask.sent.has(questionId))
          throw new WorkThreadRefused(`question "${questionId}" was sent already`);
      }
      return;
    }
    default:
      return;
  }
}
