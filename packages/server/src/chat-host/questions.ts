/**
 * Questions the chat's agent asks without waiting (the `ask_async` tool). Each is saved in the chat's session file as an
 * `omp-app/question` entry and shown in the page's Questions panel; the person answers when they have time, and the
 * answer goes back into the chat as their message, the way a typed one goes (`sendAnswer` in `loop.ts`). Answers and
 * skips are `omp-app/question-answer` entries. Custom entries never reach the model, so the question reaches it as the
 * tool call and the answer as a message.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  type AnswerQuestionParams,
  ASK_ASYNC_TOOL,
  type QuestionAnswer,
  type QuestionOption,
  type QuestionRecord,
  type QuestionRecordEvent,
} from "@omp-app/contracts/chat-host";
import { HostMethodError } from "./method-error";

const QUESTION_ENTRY = "omp-app/question";
const ANSWER_ENTRY = "omp-app/question-answer";

/** Labels omp's own `ask` keeps for its rows; the page offers its own Other…, so the agent may not use them either. */
const RESERVED_LABELS = new Set(["Other (type your own)", "Chat about this", "Next →"]);

export const ASK_ASYNC_DESCRIPTION = [
  "Ask the user questions without waiting for the answers. Each question appears in the app's Questions panel beside",
  "this chat, with your context; the user answers when they have time, and each answer arrives later in this chat as a",
  'message from the user that starts with "Answer to your question" (or "Skipped your question").',
  "The tool returns at once: keep working on what does not depend on the answers, and do not ask the same question",
  "again. Give `options` for multiple choice (the user can always write their own answer instead), or leave them out",
  "for a written answer. Put in `context` what the user needs to decide: why you ask, what each choice changes, and",
  "what you would pick. Prefer it over `ask` when the decision does not block your next step or the user may be away.",
].join(" ");

/** The tool's parameters, as omp's `ask` has them, with `context` added and `options` optional. */
export const ASK_ASYNC_PARAMETERS = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Your id for the question, unique in this call" },
          question: { type: "string" },
          header: { type: "string", description: "A short label for the question" },
          context: {
            type: "string",
            description: "Markdown: why you ask, what each choice changes, your pick",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          },
          multi: { type: "boolean", description: "Several options may be picked" },
          recommended: { type: "number", description: "0-based index of the option you recommend" },
        },
        required: ["id", "question"],
      },
    },
  },
  required: ["questions"],
} as const;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** The call's questions, checked: each with an id and a question, its options unique and none reserved. */
export function askedQuestions(
  toolCallId: string,
  args: unknown,
  askedAt: number,
): QuestionRecord[] {
  const list = (args as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error("ask_async needs at least one question");
  const seen = new Set<string>();
  return list.map((raw: unknown, index): QuestionRecord => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const questionId = text(item.id) ?? `q${index + 1}`;
    const question = text(item.question);
    if (question === undefined) throw new Error(`Question ${questionId} has no text`);
    if (seen.has(questionId)) throw new Error(`Two questions have the id ${questionId}`);
    seen.add(questionId);
    const options: QuestionOption[] = [];
    for (const option of Array.isArray(item.options) ? item.options : []) {
      const label = text((option as Record<string, unknown> | null)?.label);
      if (label === undefined) throw new Error(`An option of question ${questionId} has no label`);
      if (RESERVED_LABELS.has(label)) throw new Error(`"${label}" is the app's own option`);
      if (options.some((known) => known.label === label)) {
        throw new Error(`Question ${questionId} has the option "${label}" twice`);
      }
      const description = text((option as Record<string, unknown>).description);
      options.push(description === undefined ? { label } : { label, description });
    }
    const recommended =
      typeof item.recommended === "number" &&
      Number.isInteger(item.recommended) &&
      item.recommended >= 0 &&
      item.recommended < options.length
        ? item.recommended
        : undefined;
    const header = text(item.header);
    const context = text(item.context);
    return {
      id: `${toolCallId}:${questionId}`,
      toolCallId,
      questionId,
      question,
      ...(header === undefined ? {} : { header }),
      ...(context === undefined ? {} : { context }),
      options,
      multi: item.multi === true && options.length > 1,
      ...(recommended === undefined ? {} : { recommended }),
      askedAt,
      answer: null,
    };
  });
}

/** The person's message to the agent for an answer or a skip. */
export function answerMessage(record: QuestionRecord, answer: QuestionAnswer): string {
  const name = `"${record.header ?? record.question}" (${record.questionId})`;
  if (answer.skipped) return `Skipped your question ${name}: decide it yourself.`;
  const lines = [`Answer to your question ${name}:`];
  if (answer.picked.length === 1 && answer.typed === undefined) lines.push(answer.picked[0] ?? "");
  else for (const label of answer.picked) lines.push(`- ${label}`);
  if (answer.typed !== undefined) {
    lines.push(answer.picked.length > 0 ? `- Other: ${answer.typed}` : answer.typed);
  }
  if (answer.note !== undefined) lines.push(`Note: ${answer.note}`);
  return lines.join("\n");
}

type QuestionsSession = Pick<AgentSession, "sessionManager">;

/** The chat's questions: asked by the tool, listed, answered and skipped through the host's methods. */
export class QuestionsController {
  readonly #session: QuestionsSession;
  readonly #emit: (event: QuestionRecordEvent) => void;
  readonly #send: (message: string, sequence: number) => Promise<void>;
  /** Questions whose answer is on its way to the agent: a second answer is refused meanwhile. */
  readonly #answering = new Set<string>();

  constructor(
    session: QuestionsSession,
    emit: (event: QuestionRecordEvent) => void,
    send: (message: string, sequence: number) => Promise<void>,
  ) {
    this.#session = session;
    this.#emit = emit;
    this.#send = send;
  }

  /**
   * Saves the call's questions and tells the page; the records, for the tool's answer. Only the chat's own agent asks
   * (`caller` is omp's `ctx.agent.kind`): a subagent's answer would reach the chat's agent, not the subagent.
   */
  async ask(toolCallId: string, args: unknown, caller: "main" | "sub"): Promise<QuestionRecord[]> {
    if (caller !== "main") {
      throw new Error(
        "Only the chat's own agent can ask the user with ask_async; put the question in your final answer instead.",
      );
    }
    const records = askedQuestions(toolCallId, args, Date.now());
    const manager = this.#session.sessionManager;
    await manager.ensureOnDisk();
    for (const record of records) {
      manager.appendCustomEntry(QUESTION_ENTRY, record);
      this.#emit({ type: "question_record", record });
    }
    return records;
  }

  /** The session's questions in the order asked, each with its answer (the first one saved) once there is one. */
  list(): QuestionRecord[] {
    const records = new Map<string, QuestionRecord>();
    for (const entry of this.#session.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === QUESTION_ENTRY) {
        const record = entry.data as QuestionRecord;
        if (!records.has(record.id)) records.set(record.id, { ...record, answer: null });
      } else if (entry.customType === ANSWER_ENTRY) {
        const { id, ...answer } = entry.data as QuestionAnswer & { readonly id: string };
        const record = records.get(id);
        if (record !== undefined && record.answer === null) records.set(id, { ...record, answer });
      }
    }
    return [...records.values()];
  }

  /** Sends the person's answer to the agent, then saves it. */
  answer(params: AnswerQuestionParams, sequence: number): Promise<QuestionRecord> {
    return this.#close(params.id, sequence, (record) => {
      const picked = [...new Set(params.picked)];
      for (const label of picked) {
        if (!record.options.some((option) => option.label === label)) {
          throw new HostMethodError(
            "invalid_params",
            `"${label}" is not a choice of this question`,
          );
        }
      }
      if (!record.multi && picked.length > 1) {
        throw new HostMethodError("invalid_params", "This question takes one choice");
      }
      const typed = text(params.typed);
      const note = text(params.note);
      if (picked.length === 0 && typed === undefined) {
        throw new HostMethodError("invalid_params", "An answer needs a choice or a written answer");
      }
      return {
        picked,
        ...(typed === undefined ? {} : { typed }),
        ...(note === undefined ? {} : { note }),
        skipped: false,
        answeredAt: Date.now(),
      };
    });
  }

  /** Tells the agent to go on without the answer, then saves the skip. */
  skip(id: string, sequence: number): Promise<QuestionRecord> {
    return this.#close(id, sequence, () => ({ picked: [], skipped: true, answeredAt: Date.now() }));
  }

  async #close(
    id: string,
    sequence: number,
    answerOf: (record: QuestionRecord) => QuestionAnswer,
  ): Promise<QuestionRecord> {
    const record = this.list().find((known) => known.id === id);
    if (record === undefined)
      throw new HostMethodError("invalid_params", "No such question in this chat");
    if (record.answer !== null || this.#answering.has(id)) {
      throw new Error(
        record.answer?.skipped === true
          ? "This question was skipped"
          : "This question was already answered",
      );
    }
    const answer = answerOf(record);
    this.#answering.add(id);
    try {
      await this.#send(answerMessage(record, answer), sequence);
      this.#session.sessionManager.appendCustomEntry(ANSWER_ENTRY, { id, ...answer });
    } finally {
      this.#answering.delete(id);
    }
    const answered: QuestionRecord = { ...record, answer };
    this.#emit({ type: "question_record", record: answered });
    return answered;
  }
}

/**
 * The tool, made before the session that holds it (omp's `customTools`); the chat's loop gives it the controller once
 * the session is there, before any message can reach the agent.
 */
export class AskAsyncTool {
  #controller: QuestionsController | undefined;

  attach(controller: QuestionsController): void {
    this.#controller = controller;
  }

  /** Typed as omp's `customTools` takes it; its details are `{ questions: QuestionRecord[] }`. */
  readonly definition: ToolDefinition = {
    name: ASK_ASYNC_TOOL,
    label: "Ask without waiting",
    description: ASK_ASYNC_DESCRIPTION,
    parameters: ASK_ASYNC_PARAMETERS as unknown as TSchema,
    // Asking changes nothing on the computer; an approval for it would ask before asking.
    approval: "read",
    // Shown to the agent with its own tools, not behind a tool search.
    loadMode: "essential",
    strict: false,
    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const controller = this.#controller;
      if (controller === undefined) throw new Error("ask_async is not ready yet");
      const records = await controller.ask(toolCallId, params, ctx.agent?.kind ?? "main");
      const ids = records.map((record) => record.questionId).join(", ");
      const result: AgentToolResult<{ readonly questions: readonly QuestionRecord[] }> = {
        content: [
          {
            type: "text",
            text: `Asked ${records.length === 1 ? "1 question" : `${records.length} questions`} (${ids}). The answers come later as messages from the user in this chat. Keep working; do not wait for them, and do not ask again.`,
          },
        ],
        details: { questions: records },
      };
      return result;
    },
  };
}
