import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type SetTodoMirrorArgs,
  SiyuanBlockId,
  type TodoBoard,
  type TodoItem,
  type TodoMirror,
} from "@omp-app/contracts";
import { z } from "zod";
import { writeFileAtomic } from "../modules/A1/fs";
import type { TodoStore } from "./store";

const FILE_NAME = "siyuan-copy.json";

const Saved = z.object({
  address: z.string(),
  token: z.string(),
  target: SiyuanBlockId,
  /** The copy's own block, once written: a list block, rewritten in place. */
  block: SiyuanBlockId.nullable(),
});
type Saved = z.infer<typeof Saved>;

/** A burst of changes writes once, this long after the last. */
export const WRITE_DELAY_MS = 3_000;
/** How often the copy is read for ticks made in SiYuan. */
export const READ_EVERY_MS = 60_000;
/** The longest one call to SiYuan may take. */
const CALL_MS = 10_000;
/** The done items each list shows in the copy, the latest first. */
const DONE_SHOWN = 5;

/** One task line of the copy as written: its item, its title as shown, and whether it was ticked. */
interface Written {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

/** Text as SiYuan's Markdown shows it, its marks escaped. */
const markdown = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#|~]/g, (mark) =>
      mark === "<" ? "&lt;" : mark === ">" ? "&gt;" : `\\${mark}`,
    );

/** A task line's text as the copy's block holds it, its IALs and escapes taken off. */
const plain = (text: string): string =>
  text
    .replace(/\{:[^}]*\}/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

const dayWords = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date).toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
};

/**
 * The list as one SiYuan list block: each list's name, its open items (doing marked, due days said) and its latest done
 * ones as tasks, and a last line saying when and where it was copied from. Returns the task lines in order, to read
 * ticks back.
 */
export function copyMarkdown(
  board: TodoBoard,
  at: Date,
): { readonly text: string; readonly written: Written[] } {
  const written: Written[] = [];
  const lines: string[] = [];
  for (const list of board.lists) {
    const open = board.items.filter(
      (item) => item.list === list && (item.state === "open" || item.state === "doing"),
    );
    const done = board.items
      .filter((item) => item.list === list && item.state === "done")
      .sort((left, right) => (right.doneAt ?? 0) - (left.doneAt ?? 0))
      .slice(0, DONE_SHOWN);
    if (open.length === 0 && done.length === 0) continue;
    lines.push(`- **${markdown(list)}**`);
    for (const item of [...open, ...done]) {
      const isDone = item.state === "done";
      const notes: string[] = [];
      if (item.state === "doing") notes.push("doing");
      if (item.due !== null && !isDone) notes.push(`due ${dayWords(item.due)}`);
      const title = markdown(item.title);
      lines.push(
        `  - [${isDone ? "x" : " "}] ${title}${notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}`,
      );
      written.push({ id: item.id, title: plain(title), done: isDone });
    }
  }
  if (lines.length === 0) lines.push("- Nothing to do.");
  const time = at.toLocaleString("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  lines.push(
    `- *Copied from omp-app ${time}. Tick items here or in omp-app; change them in omp-app.*`,
  );
  return { text: lines.join("\n"), written };
}

/** The ticks of the copy's task lines, in order, with their text. */
export function ticksIn(kramdown: string): { readonly text: string; readonly done: boolean }[] {
  const ticks: { text: string; done: boolean }[] = [];
  for (const line of kramdown.split("\n")) {
    const found = /^\s*(?:[*+-]|\d+\.)\s+(?:\{:[^}]*\}\s*)?\[([ xX])\]\s?(.*)$/.exec(line);
    if (found === null) continue;
    ticks.push({ done: found[1] !== " ", text: plain(found[2] ?? "") });
  }
  return ticks;
}

export interface SiyuanMirrorOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly writeDelayMs?: number;
  readonly readEveryMs?: number;
  readonly onProblem?: (problem: string) => void;
}

/**
 * The to-do list's copy in SiYuan (D7): one list block at the end of a page, rewritten shortly after each change, and
 * read every minute for ticks made in SiYuan, which mark items done or open in the app (author "SiYuan"). The API
 * token stays in `<app data>/siyuan-copy.json` (0600) and goes only to the address set, with no redirect followed.
 */
export class SiyuanMirror {
  readonly #file: string;
  readonly #store: TodoStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #writeDelayMs: number;
  readonly #onProblem: (problem: string) => void;
  #saved: Saved | null;
  #lastWrite: TodoMirror["lastWrite"] = null;
  #written: Written[] | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #poll: ReturnType<typeof setInterval>;
  readonly #stopListening: () => void;
  /** Writes and reads one at a time. */
  #turn: Promise<unknown> = Promise.resolve();

  private constructor(
    file: string,
    store: TodoStore,
    saved: Saved | null,
    options: SiyuanMirrorOptions,
  ) {
    this.#file = file;
    this.#store = store;
    this.#saved = saved;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#writeDelayMs = options.writeDelayMs ?? WRITE_DELAY_MS;
    this.#onProblem = options.onProblem ?? (() => undefined);
    this.#stopListening = store.subscribe(() => this.#writeSoon());
    this.#poll = setInterval(() => void this.readTicks(), options.readEveryMs ?? READ_EVERY_MS);
    // A copy set before: written again at start, so its ticks can be read back.
    if (saved !== null) this.#writeSoon();
  }

  static async open(
    appDataDir: string,
    store: TodoStore,
    options: SiyuanMirrorOptions = {},
  ): Promise<SiyuanMirror> {
    const file = join(appDataDir, FILE_NAME);
    const text = await readFile(file, "utf8").catch(() => null);
    let saved: Saved | null = null;
    if (text !== null) {
      try {
        const parsed = Saved.safeParse(JSON.parse(text));
        if (parsed.success) saved = parsed.data;
      } catch {
        // A file it cannot read: no copy until it is set again.
      }
    }
    return new SiyuanMirror(file, store, saved, options);
  }

  state(): TodoMirror {
    return {
      address: this.#saved?.address ?? null,
      target: this.#saved?.target ?? null,
      tokenSaved: this.#saved !== null,
      lastWrite: this.#lastWrite,
    };
  }

  /** Sets the copy and writes it now; or turns it off, leaving its block in SiYuan. */
  async set(args: SetTodoMirrorArgs): Promise<TodoMirror> {
    if ("off" in args) {
      this.#saved = null;
      this.#written = null;
      this.#lastWrite = null;
      clearTimeout(this.#timer);
      await rm(this.#file, { force: true });
      return this.state();
    }
    const token = args.token ?? this.#saved?.token;
    if (token === undefined)
      throw new Error("SiYuan's API token is needed (Settings → About → API token).");
    const sameTarget = this.#saved?.target === args.target && this.#saved.address === args.address;
    this.#saved = {
      address: args.address.replace(/\/+$/, ""),
      token,
      target: args.target,
      block: sameTarget ? (this.#saved?.block ?? null) : null,
    };
    await this.#keep();
    await this.#inTurn(() => this.#write());
    return this.state();
  }

  /** Reads the copy for ticks made in SiYuan, and marks those items done or open. */
  readTicks(): Promise<void> {
    return this.#inTurn(async () => {
      const saved = this.#saved;
      const written = this.#written;
      if (saved === null || saved.block === null || written === null) return;
      let kramdown: string;
      try {
        const answer = await this.#call<{ kramdown: string }>("/api/block/getBlockKramdown", {
          id: saved.block,
        });
        kramdown = answer.kramdown;
      } catch (error) {
        this.#onProblem(
          `reading the copy: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      const ticks = ticksIn(kramdown);
      // Only a copy whose lines are still the ones written: an edited copy is rewritten, not read.
      if (
        ticks.length !== written.length ||
        ticks.some((tick, index) => !tick.text.startsWith(written[index]?.title ?? "\u0000"))
      ) {
        return;
      }
      for (const [index, tick] of ticks.entries()) {
        const line = written[index] as Written;
        if (tick.done === line.done) continue;
        const item = this.#store.board().items.find((each) => each.id === line.id);
        if (item === undefined || item.state === "dropped") continue;
        await this.#store
          .update({ id: line.id, state: tick.done ? "done" : "open" }, { kind: "siyuan" })
          .catch(() => undefined);
      }
    });
  }

  stop(): void {
    clearTimeout(this.#timer);
    clearInterval(this.#poll);
    this.#stopListening();
  }

  /** Waits for the writes and reads so far (tests). */
  settled(): Promise<unknown> {
    return this.#turn;
  }

  #writeSoon(): void {
    if (this.#saved === null) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#inTurn(() => this.#write()), this.#writeDelayMs);
  }

  async #write(): Promise<void> {
    const saved = this.#saved;
    if (saved === null) return;
    const { text, written } = copyMarkdown(this.#store.board(), this.#now());
    try {
      let block = saved.block;
      if (block !== null) {
        // A block that is gone (deleted in SiYuan) is written again at the page's end.
        const updated = await this.#call<unknown>("/api/block/updateBlock", {
          dataType: "markdown",
          data: text,
          id: block,
        }).then(
          () => true,
          () => false,
        );
        if (!updated) block = null;
      }
      if (block === null) {
        const appended = await this.#call<
          readonly { readonly doOperations: readonly { readonly id: string }[] }[]
        >("/api/block/appendBlock", { dataType: "markdown", data: text, parentID: saved.target });
        const id = appended[0]?.doOperations[0]?.id;
        const checked = SiyuanBlockId.safeParse(id);
        if (!checked.success) throw new Error("SiYuan did not say which block it wrote");
        this.#saved = { ...saved, block: checked.data };
        await this.#keep();
      }
      this.#written = written;
      this.#lastWrite = { at: this.#now().getTime(), ok: true, problem: null };
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      this.#lastWrite = { at: this.#now().getTime(), ok: false, problem };
      this.#onProblem(`writing the copy: ${problem}`);
    }
  }

  /** One call to SiYuan's API: its `data`, or its own words for a refusal. The token goes to the set address only. */
  async #call<T>(path: string, body: unknown): Promise<T> {
    const saved = this.#saved;
    if (saved === null) throw new Error("No SiYuan copy is set");
    const response = await this.#fetch(`${saved.address}${path}`, {
      method: "POST",
      headers: { Authorization: `Token ${saved.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (response.status === 401) throw new Error("SiYuan refused the API token");
    if (!response.ok) throw new Error(`SiYuan answered ${response.status}`);
    const answer = (await response.json()) as { code?: number; msg?: string; data?: unknown };
    if (answer.code !== 0) throw new Error(answer.msg || `SiYuan answered code ${answer.code}`);
    return answer.data as T;
  }

  async #keep(): Promise<void> {
    if (this.#saved === null) return;
    await writeFileAtomic(this.#file, `${JSON.stringify(this.#saved)}\n`);
  }

  #inTurn(work: () => Promise<void>): Promise<void> {
    const next = this.#turn.then(work, work);
    this.#turn = next.catch(() => undefined);
    return next;
  }
}

export type { TodoItem };
