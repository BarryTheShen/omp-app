import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type FolderPath, QuestionRecordSchema, type ThreadId } from "@omp-app/contracts";
import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { z } from "zod";

/** The list of every chat's waiting `ask_async` questions the dashboard kept before Workbench. */
export const QUESTIONS_FILE = "questions.json";

const Saved = z.object({
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

/**
 * The questions chats asked with `ask_async` that still wait, from the list the dashboard kept before Workbench
 * (`<app data>/questions.json`), for their carry-over into threads; null when there is no list (none, or carried over
 * already). A list it cannot read counts as empty, so it is moved aside all the same.
 */
export async function readWaitingQuestions(
  appDataDir: string,
): Promise<{ readonly file: string; readonly chats: readonly ChatQuestions[] } | null> {
  const file = join(appDataDir, QUESTIONS_FILE);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  let saved: z.infer<typeof Saved> = { chats: {} };
  try {
    const parsed = Saved.safeParse(JSON.parse(text));
    if (parsed.success) saved = parsed.data;
  } catch {
    // Not JSON: nothing to carry over.
  }
  const chats = Object.entries(saved.chats).map(([threadId, chat]) => ({
    threadId: threadId as ThreadId,
    folder: chat.folder as FolderPath | null,
    records: chat.records.filter(
      (record) => record.answer === null || record.answer.held === true,
    ) as QuestionRecord[],
  }));
  return { file, chats: chats.filter((chat) => chat.records.length > 0) };
}
