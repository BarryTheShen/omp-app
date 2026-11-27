import { z } from "zod";
import { HostRequestSchema } from "../../chat-host/host-requests";
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

/** A question a chat's agent asked without waiting (`ask_async`, before Workbench), as `questions.json` kept it. */
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

/** One chat's questions from omp that stop it until you answer (a question of omp's `ask`, a plan to approve). */
export const OpenQuestionsChat = z.strictObject({
  threadId: ThreadId,
  folder: FolderPath.nullable(),
  /** Its name as the chat list shows it; null before omp has named it. */
  title: z.string().nullable(),
  /** omp's questions that stop the chat until you answer (`isOmpQuestion`), oldest first. */
  requests: z.array(HostRequestSchema).readonly(),
});
export type OpenQuestionsChat = z.infer<typeof OpenQuestionsChat>;

export const OpenQuestionsList = z.strictObject({ chats: z.array(OpenQuestionsChat) });
export type OpenQuestionsList = z.infer<typeof OpenQuestionsList>;

/**
 * omp's questions that stop a chat until you answer, in every chat (D7), for the dashboard and Workbench: answered
 * there through each chat's own methods, a question leaves the list once omp has its answer. Each change is `changed`.
 * (Questions an agent asks without stopping are asked in Workbench, `A0.threads`.)
 */
export const QuestionsPort = definePort({
  name: "A0.questions",
  methods: {
    /** The chats with questions that wait, the one asked most recently first. */
    list: { args: z.strictObject({}), result: OpenQuestionsList },
  },
  events: {
    changed: { payload: z.strictObject({ at: z.number() }) },
  },
});
export type QuestionsPort = typeof QuestionsPort;
export type QuestionsClient = PortClient<QuestionsPort>;
export type QuestionsHandlers<Context> = PortHandlers<QuestionsPort, Context>;
