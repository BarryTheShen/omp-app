import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type FolderPath, QuestionRecordSchema, type ThreadId } from "@omp-app/contracts";
import type { QuestionAnswer, QuestionRecord } from "@omp-app/contracts/chat-host";
import { z } from "zod";
import { writeFileAtomic } from "../modules/A1/fs";

const FILE_NAME = "questions.json";

/** How far back the first start looks for questions asked before the list was kept. */
export const SCAN_DAYS = 30;

/** The session entries a chat keeps its questions in (`chat-host/questions.ts`). */
const QUESTION_ENTRY = "omp-app/question";
const ANSWER_ENTRY = "omp-app/question-answer";
const SENT_ENTRY = "omp-app/question-sent";

const Saved = z.object({
  version: z.literal(1),
  scanned: z.boolean(),
  chats: z.record(
    z.string(),
    z.object({ folder: z.string().nullable(), records: z.array(QuestionRecordSchema) }),
  ),
});

/** A chat's questions that wait: no answer yet, or an answer held to go with the rest. */
export interface ChatQuestions {
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly records: readonly QuestionRecord[];
}

/** Whether a record still waits for the person or for its chat's other answers. */
const waits = (record: QuestionRecord): boolean =>
  record.answer === null || record.answer.held === true;

interface Kept {
  folder: string | null;
  records: Map<string, QuestionRecord>;
}

/** The chats' questions from before the list was kept, read once (`scanOnce`). */
export type QuestionsScan = () => Promise<readonly ChatQuestions[]>;

/**
 * The questions every chat's agent asked without waiting (D7), for the dashboard: kept from the chats' own
 * `question_record` events (asked, answered and held, sent), in `<app data>/questions.json`, so the questions of a
 * chat that no longer runs stay listed. A question leaves the list once its answer went to its chat. The first start
 * reads the session files of the last `SCAN_DAYS` days for questions asked before.
 */
export class OpenQuestions {
  readonly filePath: string;
  readonly #chats = new Map<string, Kept>();
  readonly #listeners = new Set<() => void>();
  #scanned: boolean;
  /** Records the chats told of while the first scan ran: the scan's older word on them does not count. */
  readonly #toldLive = new Set<string>();
  #writing: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, saved: z.infer<typeof Saved>) {
    this.filePath = filePath;
    this.#scanned = saved.scanned;
    for (const [threadId, chat] of Object.entries(saved.chats)) {
      this.#chats.set(threadId, {
        folder: chat.folder,
        records: new Map(chat.records.map((record) => [record.id, record as QuestionRecord])),
      });
    }
  }

  static async open(appDataDir: string): Promise<OpenQuestions> {
    const filePath = join(appDataDir, FILE_NAME);
    const text = await readFile(filePath, "utf8").catch(() => null);
    let saved: z.infer<typeof Saved> = { version: 1, scanned: false, chats: {} };
    if (text !== null) {
      try {
        const parsed = Saved.safeParse(JSON.parse(text));
        if (parsed.success) saved = parsed.data;
      } catch {
        // A file it cannot read: the list is read again from the chats.
      }
    }
    return new OpenQuestions(filePath, saved);
  }

  /** Reads the chats' questions from before the list was kept, the first time only; later starts skip it. */
  async scanOnce(scan: QuestionsScan): Promise<void> {
    if (this.#scanned) return;
    await this.#scan(scan);
  }

  /** A chat's question as its chat now has it: asked, answered or held, or sent. */
  record(threadId: ThreadId, folder: FolderPath | null, record: QuestionRecord): void {
    this.#toldLive.add(`${threadId}\u0000${record.id}`);
    const chat = this.#chats.get(threadId) ?? { folder, records: new Map() };
    chat.folder = folder ?? chat.folder;
    if (waits(record)) chat.records.set(record.id, record);
    else if (!chat.records.delete(record.id)) return;
    if (chat.records.size === 0) this.#chats.delete(threadId);
    else this.#chats.set(threadId, chat);
    this.#changed();
  }

  /** Leaves a chat's questions out, as for a chat that is gone. */
  dismiss(threadId: ThreadId): void {
    if (this.#chats.delete(threadId)) this.#changed();
  }

  /** The chats with questions that wait, the one asked most recently first; each chat's in the order asked. */
  list(): ChatQuestions[] {
    const chats = [...this.#chats].map(([threadId, chat]) => ({
      threadId: threadId as ThreadId,
      folder: chat.folder as FolderPath | null,
      records: [...chat.records.values()].sort((left, right) => left.askedAt - right.askedAt),
    }));
    const latest = (chat: ChatQuestions): number =>
      Math.max(...chat.records.map((record) => record.askedAt));
    return chats.sort((left, right) => latest(right) - latest(left));
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Waits for the writes so far (tests, and the server's stop). */
  settled(): Promise<unknown> {
    return this.#writing;
  }

  async #scan(scan: () => Promise<readonly ChatQuestions[]>): Promise<void> {
    const found = await scan();
    for (const chat of found) {
      const kept = this.#chats.get(chat.threadId) ?? { folder: chat.folder, records: new Map() };
      for (const record of chat.records) {
        if (this.#toldLive.has(`${chat.threadId}\u0000${record.id}`)) continue;
        if (!kept.records.has(record.id)) kept.records.set(record.id, record);
      }
      if (kept.records.size > 0) this.#chats.set(chat.threadId, kept);
    }
    this.#scanned = true;
    this.#changed();
  }

  #changed(): void {
    const saved: z.infer<typeof Saved> = {
      version: 1,
      scanned: this.#scanned,
      chats: Object.fromEntries(
        [...this.#chats].map(([threadId, chat]) => [
          threadId,
          { folder: chat.folder, records: [...chat.records.values()] },
        ]),
      ),
    };
    const text = `${JSON.stringify(saved)}\n`;
    this.#writing = this.#writing
      .then(() => writeFileAtomic(this.filePath, text))
      .catch(() => undefined);
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A session file's questions that wait, read as its chat reads them (`QuestionsController.list`). */
export function waitingQuestionsIn(text: string): {
  readonly threadId: string | null;
  readonly folder: string | null;
  readonly records: QuestionRecord[];
} {
  let threadId: string | null = null;
  let folder: string | null = null;
  const records = new Map<string, QuestionRecord>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let entry: {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly cwd?: unknown;
      readonly customType?: unknown;
      readonly data?: unknown;
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session" && threadId === null) {
      threadId = typeof entry.id === "string" ? entry.id : null;
      folder = typeof entry.cwd === "string" ? entry.cwd : null;
      continue;
    }
    if (entry.type !== "custom") continue;
    if (entry.customType === QUESTION_ENTRY) {
      const parsed = QuestionRecordSchema.safeParse({ ...(entry.data as object), answer: null });
      if (parsed.success && !records.has(parsed.data.id))
        records.set(parsed.data.id, parsed.data as QuestionRecord);
    } else if (entry.customType === ANSWER_ENTRY) {
      const { id, ...answer } = entry.data as QuestionAnswer & { readonly id: string };
      const record = records.get(id);
      if (record !== undefined && (record.answer === null || record.answer.held === true))
        records.set(id, { ...record, answer });
    } else if (entry.customType === SENT_ENTRY) {
      const { ids } = entry.data as { readonly ids: readonly string[] };
      for (const id of ids) {
        const record = records.get(id);
        if (record?.answer?.held === true) records.delete(id);
      }
    }
  }
  return { threadId, folder, records: [...records.values()].filter(waits) };
}

/**
 * The questions that wait in the session files changed since `since` (epoch ms), under each of `folders` (omp's
 * session folders): a file that never names a question is skipped unread past its text's search.
 */
export async function scanSessionQuestions(
  folders: () => Promise<readonly string[]>,
  since: number,
): Promise<ChatQuestions[]> {
  const found: ChatQuestions[] = [];
  for (const folder of await folders()) {
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".jsonl") || name.includes(".bak")) continue;
      const file = join(folder, name);
      const info = await stat(file).catch(() => null);
      if (info === null || info.mtimeMs < since) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      if (!text.includes(QUESTION_ENTRY)) continue;
      const chat = waitingQuestionsIn(text);
      if (chat.threadId === null || chat.records.length === 0) continue;
      found.push({
        threadId: chat.threadId as ThreadId,
        folder: chat.folder as FolderPath | null,
        records: chat.records,
      });
    }
  }
  return found;
}
