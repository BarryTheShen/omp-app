import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import {
  ASKED_NOTICE,
  answerSummary,
  askSendLabel,
  asksInPanelOrder,
  asksOf,
  QuestionsStore,
} from "./questions";

const T = 1_790_000_000_000;

function question(id: string, overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: `call_1:${id}`,
    toolCallId: "call_1",
    questionId: id,
    question: `Question ${id}?`,
    options: [{ label: "Yes" }, { label: "No" }],
    multi: false,
    askedAt: T,
    answer: null,
    ...overrides,
  };
}

function store(): { readonly questions: QuestionsStore; readonly said: string[] } {
  const said: string[] = [];
  return { questions: new QuestionsStore((text) => said.push(text)), said };
}

describe("a chat's questions without waiting", () => {
  test("counts the open ones; an answer from any device updates the question in its place", () => {
    const { questions } = store();
    expect(questions.getSnapshot()).toMatchObject({ records: null, open: 0 });
    questions.setRecords([question("a"), question("b")]);
    expect(questions.getSnapshot().open).toBe(2);

    const answered = question("a", {
      answer: { picked: ["Yes"], skipped: false, answeredAt: T + 1_000 },
    });
    questions.apply({ type: "question_record", record: answered }, true);
    expect(questions.getSnapshot().records?.map((record) => record.answer?.picked)).toEqual([
      ["Yes"],
      undefined,
    ]);
    expect(questions.getSnapshot().open).toBe(1);
  });

  test("says a question that arrives while the chat is live, once; not one of the replay, nor an answer", () => {
    const { questions, said } = store();
    questions.setRecords([]);
    questions.apply({ type: "question_record", record: question("a") }, false);
    expect(said).toEqual([]);
    questions.apply({ type: "question_record", record: question("b") }, true);
    questions.apply({ type: "question_record", record: question("b") }, true);
    questions.apply(
      {
        type: "question_record",
        record: question("b", { answer: { picked: [], skipped: true, answeredAt: T } }),
      },
      true,
    );
    expect(said).toEqual([ASKED_NOTICE]);
    expect(questions.apply({ type: "agent_start" }, true)).toBe(false);
  });

  test("lists the asks with a question open in the order asked, then those whose answers wait, then the sent ones newest first", () => {
    const of = (call: string, id: string, overrides: Partial<QuestionRecord> = {}) =>
      question(id, { id: `${call}:${id}`, toolCallId: call, ...overrides });
    const sent = (at: number) => ({ picked: ["No"], skipped: false, answeredAt: at, sentAt: at });
    const held = { picked: ["Yes"], skipped: false, answeredAt: T, held: true } as const;
    const records = [
      // One answer went early with Send answers: the ask is open while another of its questions is.
      of("call_1", "a", { answer: sent(T + 1) }),
      of("call_1", "b"),
      of("call_2", "c", { answer: held }),
      of("call_2", "d", { answer: { picked: [], skipped: true, answeredAt: T, held: true } }),
      of("call_3", "e", { answer: sent(T + 9) }),
      of("call_4", "f", {
        answer: { picked: [], skipped: true, answeredAt: T + 2, sentAt: T + 3 },
      }),
      // Sent before answers waited: no send time, its answer time counts.
      of("call_5", "g", { answer: { picked: ["Yes"], skipped: false, answeredAt: T + 5 } }),
      of("call_6", "h"),
    ];
    const { open, waiting, answered } = asksInPanelOrder(records);
    const calls = (asks: readonly { readonly toolCallId: string }[]) =>
      asks.map((ask) => ask.toolCallId);
    expect(calls(open)).toEqual(["call_1", "call_6"]);
    expect(calls(waiting)).toEqual(["call_2"]);
    expect(calls(answered)).toEqual(["call_3", "call_5", "call_4"]);
    // Each ask keeps its questions in the order asked.
    expect(asksOf(records)[0]?.records.map((record) => record.questionId)).toEqual(["a", "b"]);
  });

  test("an ask's button saves while another ask has a question open, and sends on the last one", () => {
    const other = (id: string, overrides: Partial<QuestionRecord> = {}) =>
      question(id, { id: `call_2:${id}`, toolCallId: "call_2", ...overrides });
    const held = { picked: ["Yes"], skipped: false, answeredAt: T, held: true } as const;
    const askOf = (records: readonly QuestionRecord[], call: string) => {
      const ask = asksOf(records).find((each) => each.toolCallId === call);
      if (ask === undefined) throw new Error(`no ask ${call}`);
      return ask;
    };
    // Another ask's open question keeps this card's answers waiting.
    const records = [question("a"), question("b"), other("x")];
    expect(askSendLabel(askOf(records, "call_1"), records)).toBe("Save answers");
    expect(askSendLabel(askOf(records, "call_2"), records)).toBe("Save answer");
    // The chat's last open ask sends its answers with the ones that wait, from every ask.
    const lastOpen = [question("a"), other("x", { answer: held })];
    expect(askSendLabel(askOf(lastOpen, "call_1"), lastOpen)).toBe("Send answers");
    // A one-question card, with nothing else open or waiting, sends just its answer.
    const alone = [
      question("a", { answer: { picked: ["Yes"], skipped: false, answeredAt: T, sentAt: T } }),
      other("x"),
    ];
    expect(askSendLabel(askOf(alone, "call_2"), alone)).toBe("Send answer");
    // A card of several questions sends them together.
    expect(askSendLabel(askOf(records.slice(0, 2), "call_1"), records.slice(0, 2))).toBe(
      "Send answers",
    );
  });

  test("an answer's summary has its choices and its written answer", () => {
    const record = question("a", {
      multi: true,
      answer: { picked: ["Yes", "No"], typed: "Both, later", skipped: false, answeredAt: T },
    });
    expect(answerSummary(record)).toBe("Yes, No, Both, later");
  });
});
