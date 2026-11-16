import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ChatSearchMatch,
  ChatSearchStatus,
  FolderPath,
  SessionFilePath,
  ThreadId,
} from "@omp-app/contracts";
import type { Logger } from "../../../logging";
import { embed as embedTexts } from "./embeddings";
import { messageText, passagesOf } from "./passages";
import type { ChatSearchIndex } from "./port";
import type { ChatSearchConfig } from "./settings";

/** A chat the index covers, as the chat list knows it. */
export interface IndexedChat {
  readonly threadId: ThreadId;
  readonly sessionFile: SessionFilePath;
  readonly title: string;
  readonly folder: FolderPath;
  readonly sizeBytes: number;
}

export interface ChatIndexOptions {
  /** The index's own file (`<app data>/chat-index.sqlite`). */
  readonly path: string;
  /** Every top-level chat, in every folder. */
  readonly chats: () => Promise<readonly IndexedChat[]>;
  readonly config: () => Promise<ChatSearchConfig>;
  /** The index's progress changed (the pages read its status again). */
  readonly changed: () => void;
  readonly embed?: typeof embedTexts;
  readonly logger?: Logger;
  /** How often the chats are looked at for new talk. */
  readonly everyMs?: number;
  /** How long indexing waits after the service failed. */
  readonly retryMs?: number;
}

/** Bytes read from a session file at a time: a big file (long tool output) never sits in memory whole. */
const READ_BYTES = 8 * 1024 * 1024;
/** The query instruction Qwen3-Embedding is trained with (its format `Instruct: <task>\nQuery: `); passages are plain. */
const QUERY_INSTRUCTION =
  "Instruct: Given a search query, retrieve relevant passages from chats\nQuery: ";
/**
 * Matches less close than this are left out (cosine, Qwen3-Embedding 0.6B). Set from 350 real chats on 2026-11-16: the
 * real matches scored 0.6 to 0.85, chats about something else 0.45 to 0.5, and a query no chat was about 0.38.
 */
export const FLOOR = 0.45;
/** Matches this far below the best are left out too: one clear match is not followed by the chats merely near it. */
export const BELOW_BEST = 0.25;
/** How soon after a chat's turn ends its new talk is indexed. */
export const NUDGE_MS = 5_000;

type Kind = "title" | "passage" | "tail";
interface Chunk {
  readonly id: number;
  readonly kind: Kind;
  readonly text: string;
  readonly vector: Float32Array;
}
interface FileState {
  thread: ThreadId;
  title: string;
  folder: FolderPath;
  doneTo: number;
  tail: string;
  chunks: Chunk[];
}

/** The vector scaled to length 1, so a dot product is the cosine. */
function normalized(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const length = Math.sqrt(sum) || 1;
  return vector.map((x) => x / length);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** The messages a session file holds from `from`, up to its last whole line: their texts and where that line ends. */
async function readMessages(
  file: string,
  from: number,
  size: number,
): Promise<{ texts: string[]; doneTo: number }> {
  const texts: string[] = [];
  let at = from;
  let carry = "";
  let doneTo = from;
  const decoder = new TextDecoder();
  while (at < size) {
    const end = Math.min(at + READ_BYTES, size);
    const bytes = new Uint8Array(await Bun.file(file).slice(at, end).arrayBuffer());
    const text = carry + decoder.decode(bytes, { stream: end < size });
    const lastNewline = text.lastIndexOf("\n");
    const whole = lastNewline < 0 ? "" : text.slice(0, lastNewline);
    carry = lastNewline < 0 ? text : text.slice(lastNewline + 1);
    for (const line of whole.split("\n")) {
      const said = line.includes('"type":"message"') ? messageText(line) : null;
      if (said !== null) texts.push(said);
    }
    if (lastNewline >= 0) doneTo = end - Buffer.byteLength(carry);
    at = end;
  }
  return { texts, doneTo };
}

export function createChatIndex(options: ChatIndexOptions): ChatSearchIndex & {
  start(): void;
  stop(): void;
  /** A chat's turn ended: its new talk is indexed within `NUDGE_MS`, not at the next two-minute look. */
  nudge(): void;
  /** Brings the index up to date once (the background run, and the tests). */
  runOnce(): Promise<void>;
} {
  const embed = options.embed ?? embedTexts;
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (file TEXT PRIMARY KEY, thread TEXT NOT NULL, title TEXT NOT NULL,
      folder TEXT NOT NULL, done_to INTEGER NOT NULL, tail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, file TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, vector BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file);`);

  const files = new Map<string, FileState>();
  for (const row of db
    .query("SELECT file, thread, title, folder, done_to, tail FROM files")
    .all() as {
    file: string;
    thread: string;
    title: string;
    folder: string;
    done_to: number;
    tail: string;
  }[]) {
    files.set(row.file, {
      thread: row.thread as ThreadId,
      title: row.title,
      folder: row.folder as FolderPath,
      doneTo: row.done_to,
      tail: row.tail,
      chunks: [],
    });
  }
  for (const row of db.query("SELECT id, file, kind, text, vector FROM chunks").all() as {
    id: number;
    file: string;
    kind: Kind;
    text: string;
    vector: Uint8Array;
  }[]) {
    const vector = new Float32Array(
      row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength),
    );
    files.get(row.file)?.chunks.push({ id: row.id, kind: row.kind, text: row.text, vector });
  }

  /** The chats of the last listing, and the size each was last brought up to date at (this run of the app). */
  let listing: readonly IndexedChat[] = [];
  const seenSize = new Map<string, number>();
  let indexing = false;
  let problem: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the next run is due (epoch ms), while one is. */
  let dueAt: number | undefined;
  let started = false;
  let closed = false;
  /** The run going on, so a second is not started beside it; a change meanwhile runs once more after it. */
  let running: Promise<void> | undefined;
  let rerun = false;

  const insert = db.prepare(
    "INSERT INTO chunks (file, kind, text, vector) VALUES (?, ?, ?, ?) RETURNING id",
  );
  const upsertFile = db.prepare(
    "INSERT OR REPLACE INTO files (file, thread, title, folder, done_to, tail) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const forget = (file: string): void => {
    db.query("DELETE FROM chunks WHERE file = ?").run(file);
    db.query("DELETE FROM files WHERE file = ?").run(file);
    files.delete(file);
  };

  const store = (
    file: string,
    state: FileState,
    add: { kind: Kind; text: string; vector: Float32Array }[],
    drop: Kind[],
  ) => {
    db.transaction(() => {
      for (const kind of drop)
        db.query("DELETE FROM chunks WHERE file = ? AND kind = ?").run(file, kind);
      state.chunks = state.chunks.filter((chunk) => !drop.includes(chunk.kind));
      for (const each of add) {
        const vector = normalized(each.vector);
        const row = insert.get(file, each.kind, each.text, new Uint8Array(vector.buffer)) as {
          id: number;
        };
        state.chunks.push({ id: row.id, kind: each.kind, text: each.text, vector });
      }
      upsertFile.run(file, state.thread, state.title, state.folder, state.doneTo, state.tail);
    })();
    files.set(file, state);
  };

  /** One chat brought up to date: its title, the talk added since, its tail. */
  const indexChat = async (config: ChatSearchConfig, chat: IndexedChat): Promise<void> => {
    const known = files.get(chat.sessionFile);
    // A file that shrank was written anew: it is read from the start.
    const fresh = known === undefined || chat.sizeBytes < known.doneTo;
    if (fresh && known !== undefined) forget(chat.sessionFile);
    const state: FileState = fresh
      ? { thread: chat.threadId, title: "", folder: chat.folder, doneTo: 0, tail: "", chunks: [] }
      : (known as FileState);
    const titleChanged = state.title !== chat.title;
    const grew = chat.sizeBytes > state.doneTo;
    if (!titleChanged && !grew) return;
    const read = grew
      ? await readMessages(chat.sessionFile, state.doneTo, chat.sizeBytes)
      : { texts: [], doneTo: state.doneTo };
    const { passages, tail } = passagesOf(state.tail, read.texts);
    const texts = [
      ...(titleChanged && chat.title !== "" ? [chat.title] : []),
      ...passages,
      ...(tail !== state.tail && tail !== "" ? [tail] : []),
    ];
    const vectors = texts.length === 0 ? [] : await embed(config, texts);
    let at = 0;
    const add: { kind: Kind; text: string; vector: Float32Array }[] = [];
    const drop: Kind[] = [];
    if (titleChanged) {
      drop.push("title");
      if (chat.title !== "")
        add.push({ kind: "title", text: chat.title, vector: vectors[at++] as Float32Array });
    }
    for (const passage of passages)
      add.push({ kind: "passage", text: passage, vector: vectors[at++] as Float32Array });
    if (tail !== state.tail) {
      drop.push("tail");
      if (tail !== "")
        add.push({ kind: "tail", text: tail, vector: vectors[at++] as Float32Array });
    }
    store(
      chat.sessionFile,
      { ...state, title: chat.title, folder: chat.folder, doneTo: read.doneTo, tail },
      add,
      drop,
    );
    seenSize.set(chat.sessionFile, chat.sizeBytes);
  };

  const run = async (): Promise<void> => {
    const config = await options.config();
    if (!config.enabled || config.address === "" || config.model === "") return;
    // Vectors of another model or service do not compare with new ones: a change of either starts the index anew.
    const fingerprint = `${config.address}\n${config.model}`;
    const before = (
      db.query("SELECT value FROM meta WHERE key = 'service'").get() as { value: string } | null
    )?.value;
    if (before !== fingerprint) {
      db.exec("DELETE FROM chunks; DELETE FROM files;");
      files.clear();
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('service', ?)").run(fingerprint);
    }
    indexing = true;
    options.changed();
    try {
      const chats = await options.chats();
      listing = chats;
      const present = new Set(chats.map((chat) => chat.sessionFile as string));
      for (const file of [...files.keys()]) if (!present.has(file)) forget(file);
      let done = 0;
      for (const chat of chats) {
        if (closed) break;
        if (
          seenSize.get(chat.sessionFile) === chat.sizeBytes &&
          files.get(chat.sessionFile)?.title === chat.title
        )
          continue;
        await indexChat(config, chat);
        done += 1;
        if (done % 20 === 0) options.changed();
      }
      problem = null;
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
      options.logger?.warn("chat_search.index_failed", { error: problem });
      throw failure;
    } finally {
      indexing = false;
      options.changed();
    }
  };

  const runOnce = (): Promise<void> => {
    if (running !== undefined) {
      rerun = true;
      return running;
    }
    running = run().finally(() => {
      running = undefined;
    });
    return running;
  };

  const schedule = (ms: number): void => {
    if (!started || closed) return;
    clearTimeout(timer);
    dueAt = Date.now() + ms;
    timer = setTimeout(() => {
      timer = undefined;
      dueAt = undefined;
      rerun = false;
      void runOnce()
        .then(() => schedule(rerun ? 1_000 : (options.everyMs ?? 120_000)))
        .catch(() => schedule(options.retryMs ?? 300_000));
    }, ms);
  };

  return {
    status: (): ChatSearchStatus => ({
      chats: listing.length,
      indexed: listing.filter((chat) => seenSize.get(chat.sessionFile) === chat.sizeBytes).length,
      indexing,
      problem,
    }),
    search: async (config, query, limit): Promise<ChatSearchMatch[]> => {
      const [raw] = await embed(config, [`${QUERY_INSTRUCTION}${query}`]);
      const wanted = normalized(raw as Float32Array);
      const best: { file: string; state: FileState; chunk: Chunk; score: number }[] = [];
      for (const [file, state] of files) {
        let top: { chunk: Chunk; score: number } | undefined;
        for (const chunk of state.chunks) {
          const score = dot(wanted, chunk.vector);
          if (top === undefined || score > top.score) top = { chunk, score };
        }
        if (top !== undefined && top.score >= FLOOR) best.push({ file, state, ...top });
      }
      best.sort((a, b) => b.score - a.score);
      const cutoff = (best[0]?.score ?? 0) - BELOW_BEST;
      // A chat kept twice (a copy, a branch with the same start) shows once: its title and passage are the same.
      const seen = new Set<string>();
      const unique = best.filter(({ state, chunk, score }) => {
        const key = `${state.title}\n${chunk.text}`;
        if (score < cutoff || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return unique.slice(0, limit).map(({ file, state, chunk, score }) => ({
        threadId: state.thread,
        title: state.title,
        folder: state.folder,
        sessionFile: file as SessionFilePath,
        passage: chunk.text,
        score: Math.round(score * 1000) / 1000,
      }));
    },
    settingsChanged: () => {
      // A run going on reads the settings again right after it; otherwise one starts in a second.
      if (running !== undefined) rerun = true;
      else schedule(1_000);
    },
    nudge: () => {
      if (running !== undefined) rerun = true;
      // Never later than it was due: turns ending one after another do not keep putting the run off.
      else if (dueAt === undefined || dueAt > Date.now() + NUDGE_MS) schedule(NUDGE_MS);
    },
    start: () => {
      started = true;
      schedule(5_000);
    },
    stop: () => {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      // A run going on stops after its chat; the file closes after it.
      void (running ?? Promise.resolve()).catch(() => {}).finally(() => db.close());
    },
    runOnce: () => runOnce(),
  };
}
