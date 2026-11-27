import { rename } from "node:fs/promises";
import type { ThreadId, WorkThreadQuestion } from "@omp-app/contracts";
import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { ZodError } from "zod";
import type { ChatQuestions } from "../questions/open-questions";
import { WorkThreadRefused, type WorkThreadStore } from "./store";

/** What the carry-over writes as: the app itself, not the person or a chat. */
const APP = { kind: "app" } as const;

/** A question as a thread's ask takes it. */
const questionOf = (record: QuestionRecord): WorkThreadQuestion => ({
  id: record.questionId,
  question: record.question,
  ...(record.header === undefined ? {} : { header: record.header }),
  ...(record.context === undefined ? {} : { context: record.context }),
  options: record.options.map((option) => ({
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  })),
  multi: record.multi,
  ...(record.recommended === undefined ? {} : { recommended: record.recommended }),
});

/**
 * Carries the questions chats asked with `ask_async` (before Workbench) into threads, once: each chat with questions
 * still waiting gets a thread "Questions from <chat>", owned by that chat, one ask per tool call in the order asked;
 * an answer given and held (waiting for the rest) is kept as that question's answer. The old list is then moved aside
 * (`<file>.migrated`), so the carry-over never runs twice; moving it back undoes it on a release before this one.
 * Answers the person gives from then on reach each chat as a notice from its thread.
 */
export async function carryOverQuestions(
  store: WorkThreadStore,
  chats: readonly ChatQuestions[],
  titleOf: (threadId: ThreadId) => Promise<string | null>,
  listFile: string,
): Promise<number> {
  let made = 0;
  for (const chat of chats) {
    if (chat.records.length === 0) continue;
    const title = await titleOf(chat.threadId).catch(() => null);
    const thread = await store.open(
      {
        title: `Questions from ${title ?? "a chat"}`.slice(0, 200),
        kind: "question",
        text: "Questions this chat asked before Workbench, carried over: answer them here, and the answers go to the chat.",
        owner: chat.threadId,
      },
      APP,
    );
    const asks = new Map<string, QuestionRecord[]>();
    for (const record of [...chat.records].sort((left, right) => left.askedAt - right.askedAt)) {
      asks.set(record.toolCallId, [...(asks.get(record.toolCallId) ?? []), record]);
    }
    for (const records of asks.values()) {
      let ask: string;
      try {
        ask = (
          await store.post(thread.id, { type: "question", questions: records.map(questionOf) }, APP)
        ).entry.id;
      } catch (error) {
        if (!(error instanceof WorkThreadRefused) && !(error instanceof ZodError)) throw error;
        // An ask the thread cannot take as questions (old data: two choices of one label, say) is kept as words.
        const words = records
          .map((record) => `- ${record.header ?? record.question} (${record.questionId})`)
          .join("\n");
        await store.post(
          thread.id,
          { type: "message", text: `Carried over as text:\n${words}` },
          APP,
        );
        continue;
      }
      for (const record of records) {
        const answer = record.answer;
        if (answer === null || answer.held !== true) continue;
        await store
          .post(
            thread.id,
            {
              type: "answer",
              ask,
              questionId: record.questionId,
              answer: {
                picked: [...answer.picked],
                ...(answer.typed === undefined ? {} : { typed: answer.typed }),
                ...(answer.note === undefined ? {} : { note: answer.note }),
                skipped: answer.skipped,
              },
            },
            { kind: "person" },
          )
          // An answer the question cannot take stays unanswered: the person answers it again.
          .catch((error: unknown) => {
            if (!(error instanceof WorkThreadRefused) && !(error instanceof ZodError)) throw error;
          });
      }
    }
    made += 1;
  }
  await rename(listFile, `${listFile}.migrated`);
  return made;
}
