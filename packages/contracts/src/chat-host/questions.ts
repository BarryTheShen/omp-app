/**
 * Questions an agent asked without waiting (the chat host's `ask_async` tool, before Workbench): a question with its
 * choices and the person's answer. Workbench asks with `thread_ask` now; these shapes remain for the questions carried
 * over into threads, the answer fields both share, and the `ask_async` calls old chats hold in their transcripts.
 */
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
  /**
   * True while the answer waits for the rest of its ask's answers (or for the person to send it); it can still be
   * changed then. Absent once it went to the agent, and on answers from before answers waited.
   */
  readonly held?: true;
  /** When it went to the agent (epoch ms); absent while held, and on answers from before answers waited. */
  readonly sentAt?: number;
  /**
   * True on an answer the person took back (`reopen_answers`) before omp read it, until they change it: it waits again,
   * and the answers go only when sent (Send answers) or once every answer taken back is changed.
   */
  readonly reopened?: true;
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
