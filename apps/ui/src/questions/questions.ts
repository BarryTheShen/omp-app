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

/** One ask: the questions one call of `ask_async` asked, in the order asked. The panel shows it as one card. */
export interface Ask {
  /** The tool call that asked them: the ask's own id. */
  readonly toolCallId: string;
  readonly records: readonly QuestionRecord[];
}

/** The chat's questions by ask: the asks in the order asked, each ask's questions in the order asked. */
export function asksOf(records: readonly QuestionRecord[]): readonly Ask[] {
  const asks = new Map<string, QuestionRecord[]>();
  for (const record of records) {
    const ask = asks.get(record.toolCallId);
    if (ask === undefined) asks.set(record.toolCallId, [record]);
    else ask.push(record);
  }
  return [...asks].map(([toolCallId, asked]) => ({ toolCallId, records: asked }));
}

/** The ask's answers that have not gone to omp yet: its open questions and its waiting answers, which its card sends. */
export function unsent(ask: Ask): readonly QuestionRecord[] {
  return ask.records.filter((record) => record.answer === null || record.answer.held === true);
}

/**
 * The asks as the panel lists them: those with a question still open, in the order asked; then those whose answers all
 * wait to go with the rest; then those that went to omp, newest first. An ask with an open question is open, whatever
 * its other answers are (some may have gone early, with Send answers).
 */
export function asksInPanelOrder(records: readonly QuestionRecord[]): {
  readonly open: readonly Ask[];
  readonly waiting: readonly Ask[];
  readonly answered: readonly Ask[];
} {
  const asks = asksOf(records);
  const isOpen = (ask: Ask): boolean => ask.records.some((record) => record.answer === null);
  const isWaiting = (ask: Ask): boolean =>
    !isOpen(ask) && ask.records.some((record) => record.answer?.held === true);
  const sentAt = (ask: Ask): number =>
    Math.max(
      ...ask.records.map((record) => record.answer?.sentAt ?? record.answer?.answeredAt ?? 0),
    );
  return {
    open: asks.filter(isOpen),
    waiting: asks.filter(isWaiting),
    answered: asks
      .filter((ask) => !isOpen(ask) && !isWaiting(ask))
      .sort((left, right) => sentAt(right) - sentAt(left)),
  };
}

/**
 * What an ask's button does, by what is left open in the chat, whichever ask it came from: it saves the card's answers
 * to wait for the other open asks, or, on the chat's last open ask, sends them with the answers that wait.
 */
export function askSendLabel(
  ask: Ask,
  records: readonly QuestionRecord[],
): "Save answer" | "Save answers" | "Send answer" | "Send answers" {
  const mine = new Set(ask.records.map((record) => record.id));
  const others = records.filter((record) => !mine.has(record.id));
  const several = unsent(ask).length > 1;
  if (others.some((record) => record.answer === null))
    return several ? "Save answers" : "Save answer";
  return several || others.some((record) => record.answer?.held === true)
    ? "Send answers"
    : "Send answer";
}

/** An answer in a few words: the choices and the written answer, or Skipped. */
export function answerSummary(record: QuestionRecord): string {
  const answer = record.answer;
  if (answer === null) return "";
  if (answer.skipped) return "Skipped";
  return [...answer.picked, ...(answer.typed === undefined ? [] : [answer.typed])].join(", ");
}
