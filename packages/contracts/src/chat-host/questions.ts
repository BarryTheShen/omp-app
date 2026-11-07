/**
 * Questions an agent asks without waiting (the chat host's `ask_async` tool): each is kept in the chat's session, shown
 * in the page's BTW panel, and answered there whenever the person has time; the answer goes back into the chat as the
 * person's message.
 */
import { z } from "zod";

/** The tool an agent asks with. */
export const ASK_ASYNC_TOOL = "ask_async";

/** One choice of a question, as omp's `ask` gives it. */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

/** What the person did with a question: the choices picked and a written answer, with a note; or a skip. */
export interface QuestionAnswer {
  readonly picked: readonly string[];
  readonly typed?: string;
  readonly note?: string;
  readonly skipped: boolean;
  /** Epoch ms. */
  readonly answeredAt: number;
}

/** A question an agent asked, and its answer once there is one. */
export interface QuestionRecord {
  /** Unique in the chat: the tool call's id and the question's own id. */
  readonly id: string;
  readonly toolCallId: string;
  /** The agent's id for it (omp's `ask` `id`). */
  readonly questionId: string;
  readonly question: string;
  /** A short label (omp's `ask` `header`). */
  readonly header?: string;
  /** Why the agent asks and what each answer changes, in Markdown. */
  readonly context?: string;
  /** None: the person writes the answer. */
  readonly options: readonly QuestionOption[];
  /** Several choices may be picked. */
  readonly multi: boolean;
  /** The choice the agent recommends, by index. */
  readonly recommended?: number;
  /** Epoch ms. */
  readonly askedAt: number;
  readonly answer: QuestionAnswer | null;
}

export const AnswerQuestionParams = z.object({
  id: z.string().min(1),
  /** Labels of the question's choices. */
  picked: z.array(z.string().min(1)).max(100),
  /** A written answer: Other…, or the answer to a question without choices. */
  typed: z.string().max(20_000).optional(),
  note: z.string().max(20_000).optional(),
});
export type AnswerQuestionParams = z.infer<typeof AnswerQuestionParams>;

export const SkipQuestionParams = z.object({ id: z.string().min(1) });
export type SkipQuestionParams = z.infer<typeof SkipQuestionParams>;

/** A question was asked, answered or skipped: its whole record. */
export interface QuestionRecordEvent {
  readonly type: "question_record";
  readonly record: QuestionRecord;
}
