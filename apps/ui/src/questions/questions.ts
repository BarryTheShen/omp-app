import type { ChatEvent, QuestionRecord } from "@omp-app/contracts/chat-host";

export interface QuestionsSnapshot {
  /** The chat's questions in the order asked; null until they are read. */
  readonly records: readonly QuestionRecord[] | null;
  /** How many wait for an answer. */
  readonly open: number;
}

const EMPTY: QuestionsSnapshot = { records: null, open: 0 };

/** What the arrival notice says: the person may be looking at another chat or another app. */
export const ASKED_NOTICE =
  "omp asked you a question. Answer it in the Questions panel when you have time.";

/**
 * The questions a chat's agent asked without waiting (`ask_async`), for the Questions panel and the rail's count: read with
 * `get_questions` and kept current by the chat host's `question_record` events. A question that arrives while the chat
 * is live is said once, by `say`.
 */
export class QuestionsStore {
  #snapshot: QuestionsSnapshot = EMPTY;
  readonly #listeners = new Set<() => void>();
  readonly #say: (text: string) => void;

  constructor(say: (text: string) => void) {
    this.#say = say;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): QuestionsSnapshot => this.#snapshot;

  /** The questions as the host listed them. */
  setRecords(records: readonly QuestionRecord[]): void {
    this.#publish([...records]);
  }

  /** A record as the host sent it (asked, answered or skipped): it takes its own place, or joins at the end. */
  put(record: QuestionRecord): void {
    const records = this.#snapshot.records ?? [];
    const at = records.findIndex((known) => known.id === record.id);
    this.#publish(
      at === -1
        ? [...records, record]
        : records.map((known, index) => (index === at ? record : known)),
    );
  }

  /** Takes the `question_record` events; false for any other. `live`: an event of now, not of the replay. */
  apply(event: ChatEvent, live: boolean): boolean {
    if (event.type !== "question_record") return false;
    const known = this.#snapshot.records?.some((record) => record.id === event.record.id) ?? false;
    this.put(event.record);
    if (live && !known && event.record.answer === null) this.#say(ASKED_NOTICE);
    return true;
  }

  /** The chat moved to another session: its questions are read again. */
  reset(): void {
    this.#publish(null);
  }

  #publish(records: readonly QuestionRecord[] | null): void {
    const open = records?.filter((record) => record.answer === null).length ?? 0;
    this.#snapshot = { records, open };
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * The questions as the panel lists them: the open ones in the order asked, then the answers that wait to go with the
 * rest (in the order asked), then the answers that went to omp, newest first.
 */
export function inPanelOrder(records: readonly QuestionRecord[]): {
  readonly open: readonly QuestionRecord[];
  readonly waiting: readonly QuestionRecord[];
  readonly answered: readonly QuestionRecord[];
} {
  const sentAt = (record: QuestionRecord): number =>
    record.answer?.sentAt ?? record.answer?.answeredAt ?? 0;
  return {
    open: records.filter((record) => record.answer === null),
    waiting: records.filter((record) => record.answer?.held === true),
    answered: records
      .filter((record) => record.answer !== null && record.answer.held !== true)
      .sort((left, right) => sentAt(right) - sentAt(left)),
  };
}

/**
 * What an open question's send button does, by what is left open in the chat, whichever ask it came from: it saves the
 * answer to wait for the other open questions, or, as the chat's last open question, sends it with the waiting answers.
 */
export function sendLabel(
  record: QuestionRecord,
  records: readonly QuestionRecord[],
): "Save answer" | "Send answer" | "Send answers" {
  const others = records.filter((known) => known.id !== record.id);
  if (others.some((known) => known.answer === null)) return "Save answer";
  return others.some((known) => known.answer?.held === true) ? "Send answers" : "Send answer";
}

/** An answer in a few words: the choices and the written answer, or Skipped. */
export function answerSummary(record: QuestionRecord): string {
  const answer = record.answer;
  if (answer === null) return "";
  if (answer.skipped) return "Skipped";
  return [...answer.picked, ...(answer.typed === undefined ? [] : [answer.typed])].join(", ");
}
