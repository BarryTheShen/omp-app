import { z } from "zod";
import type { QuestionRecord } from "../../chat-host/questions";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath, ThreadId } from "../../core/ids";

const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

const QuestionAnswerSchema = z.object({
  picked: z.array(z.string()).readonly(),
  typed: z.string().optional(),
  note: z.string().optional(),
  skipped: z.boolean(),
  answeredAt: z.number(),
  held: z.literal(true).optional(),
  sentAt: z.number().optional(),
});

/** A question a chat's agent asked without waiting (`ask_async`), as the chat keeps it. */
export const QuestionRecordSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  questionId: z.string(),
  question: z.string(),
  header: z.string().optional(),
  context: z.string().optional(),
  options: z.array(QuestionOptionSchema).readonly(),
  multi: z.boolean(),
  recommended: z.number().optional(),
  askedAt: z.number(),
  answer: QuestionAnswerSchema.nullable(),
}) satisfies z.ZodType<QuestionRecord>;

/** One chat's questions that wait: open ones, and answers given that wait to go with the rest (or for Send now). */
export const OpenQuestionsChat = z.strictObject({
  threadId: ThreadId,
  folder: FolderPath.nullable(),
  /** Its name as the chat list shows it; null before omp has named it. */
  title: z.string().nullable(),
  /** In the order asked: those with no answer, and those whose answer is held (`answer.held`). */
  records: z.array(QuestionRecordSchema).readonly(),
});
export type OpenQuestionsChat = z.infer<typeof OpenQuestionsChat>;

export const OpenQuestionsList = z.strictObject({ chats: z.array(OpenQuestionsChat) });
export type OpenQuestionsList = z.infer<typeof OpenQuestionsList>;

/**
 * The questions every chat's agent asked without waiting and that wait for you (D7), for the dashboard: answered there
 * through each chat's own methods, a question leaves the list once its answer went to the chat. Each change is
 * `changed`.
 */
export const QuestionsPort = definePort({
  name: "A0.questions",
  methods: {
    /** The chats with questions that wait, the one asked most recently first. */
    list: { args: z.strictObject({}), result: OpenQuestionsList },
    /** Leaves a chat's questions out of the list, as for a chat that is gone; the chat itself keeps them. */
    dismiss: { args: z.strictObject({ threadId: ThreadId }), result: z.null() },
  },
  events: {
    changed: { payload: z.strictObject({ at: z.number() }) },
  },
});
export type QuestionsPort = typeof QuestionsPort;
export type QuestionsClient = PortClient<QuestionsPort>;
export type QuestionsHandlers<Context> = PortHandlers<QuestionsPort, Context>;
