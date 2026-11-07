import type { ChatEvent, QuestionRecord } from "@omp-app/contracts/chat-host";

export interface QuestionsSnapshot {
  /** The chat's questions in the order asked; null until they are read. */
  readonly records: readonly QuestionRecord[] | null;
  /** How many wait for an answer. */
  readonly open: number;
  /** The question to bring into view, once: the arrival notice's button asks for it. */
  readonly focused: string | null;
}

const EMPTY: QuestionsSnapshot = { records: null, open: 0, focused: null };

/** What the arrival notice says: the person may be looking at another chat or another app. */
export const ASKED_NOTICE =
  "omp asked you a question. Answer it in the BTW panel when you have time.";

/**
 * The questions a chat's agent asked without waiting (`ask_async`), for the BTW panel and the rail's count: read with
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
    this.#publish([...records], this.#snapshot.focused);
  }

  /** A record as the host sent it (asked, answered or skipped): it takes its own place, or joins at the end. */
  put(record: QuestionRecord): void {
    const records = this.#snapshot.records ?? [];
    const at = records.findIndex((known) => known.id === record.id);
    this.#publish(
      at === -1
        ? [...records, record]
        : records.map((known, index) => (index === at ? record : known)),
      this.#snapshot.focused,
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

  /** Brings a question into view in the BTW panel. */
  focus(id: string): void {
    this.#publish(this.#snapshot.records, id);
  }

  /** The panel brought it into view. */
  focused(): void {
    if (this.#snapshot.focused !== null) this.#publish(this.#snapshot.records, null);
  }

  /** The chat moved to another session: its questions are read again. */
  reset(): void {
    this.#publish(null, null);
  }

  #publish(records: readonly QuestionRecord[] | null, focused: string | null): void {
    const open = records?.filter((record) => record.answer === null).length ?? 0;
    this.#snapshot = { records, open, focused };
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The questions as the panel lists them: the open ones in the order asked, then the answered ones, newest first. */
export function inPanelOrder(records: readonly QuestionRecord[]): {
  readonly open: readonly QuestionRecord[];
  readonly answered: readonly QuestionRecord[];
} {
  return {
    open: records.filter((record) => record.answer === null),
    answered: records
      .filter((record) => record.answer !== null)
      .sort((left, right) => (right.answer?.answeredAt ?? 0) - (left.answer?.answeredAt ?? 0)),
  };
}

/** An answer in a few words: the choices and the written answer, or Skipped. */
export function answerSummary(record: QuestionRecord): string {
  const answer = record.answer;
  if (answer === null) return "";
  if (answer.skipped) return "Skipped";
  return [...answer.picked, ...(answer.typed === undefined ? [] : [answer.typed])].join(", ");
}
