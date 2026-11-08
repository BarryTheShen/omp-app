import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { ASKED_NOTICE, answerSummary, inPanelOrder, QuestionsStore, sendLabel } from "./questions";

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

  test("lists the open questions in the order asked, then the waiting answers, then the sent ones newest first", () => {
    const records = [
      question("a", {
        answer: { picked: ["No"], skipped: false, answeredAt: T + 1, sentAt: T + 9 },
      }),
      question("b"),
      question("c", { answer: { picked: [], skipped: true, answeredAt: T + 2, sentAt: T + 3 } }),
      question("d", { answer: { picked: ["Yes"], skipped: false, answeredAt: T + 4, held: true } }),
      question("e"),
      // Sent before answers waited: no send time, its answer time counts.
      question("f", { answer: { picked: ["Yes"], skipped: false, answeredAt: T + 5 } }),
    ];
    const { open, waiting, answered } = inPanelOrder(records);
    expect(open.map((record) => record.questionId)).toEqual(["b", "e"]);
    expect(waiting.map((record) => record.questionId)).toEqual(["d"]);
    expect(answered.map((record) => record.questionId)).toEqual(["a", "f", "c"]);
    expect(answered.map(answerSummary)).toEqual(["No", "Yes", "Skipped"]);
  });

  test("a question's button saves while its ask has other open questions, and sends on the last one", () => {
    const other = (id: string) => question(id, { id: `call_2:${id}`, toolCallId: "call_2" });
    const held = { picked: ["Yes"], skipped: false, answeredAt: T, held: true } as const;
    const records = [question("a"), question("b", { answer: held }), question("c"), other("x")];
    expect(sendLabel(records[0] as QuestionRecord, records)).toBe("Save answer");
    // The ask's last open question sends the waiting answers with it; another ask does not count.
    const lastOpen = [
      question("a", { answer: held }),
      question("b", { answer: held }),
      question("c"),
      other("x"),
    ];
    expect(sendLabel(lastOpen[2] as QuestionRecord, lastOpen)).toBe("Send answers");
    // Alone in its ask, or with the rest of the ask already sent, it sends just itself.
    expect(sendLabel(records[3] as QuestionRecord, records)).toBe("Send answer");
    const sentBefore = [
      question("a", { answer: { picked: ["Yes"], skipped: false, answeredAt: T, sentAt: T } }),
      question("c"),
    ];
    expect(sendLabel(sentBefore[1] as QuestionRecord, sentBefore)).toBe("Send answer");
  });

  test("an answer's summary has its choices and its written answer", () => {
    const record = question("a", {
      multi: true,
      answer: { picked: ["Yes", "No"], typed: "Both, later", skipped: false, answeredAt: T },
    });
    expect(answerSummary(record)).toBe("Yes, No, Both, later");
  });
});
