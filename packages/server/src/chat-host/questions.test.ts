import { describe, expect, test } from "bun:test";
import { QuestionsController } from "./questions";

/** A session's custom entries, kept in memory as omp's session manager keeps them in the file. */
function fakeSession() {
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  return {
    entries,
    session: {
      sessionManager: {
        ensureOnDisk: async () => undefined,
        appendCustomEntry: (customType: string, data: unknown) => {
          entries.push({ type: "custom", customType, data });
        },
        getEntries: () => entries,
      },
    } as never,
  };
}

function controller() {
  const { session, entries } = fakeSession();
  const sent: string[] = [];
  const questions = new QuestionsController(
    session,
    () => undefined,
    async (message) => {
      sent.push(message);
    },
  );
  return { questions, sent, entries };
}

const TWO = {
  questions: [
    { id: "color", question: "Which color?" },
    { id: "size", question: "Which size?" },
  ],
};

describe("answers taken back before omp read them", () => {
  test("wait again, changeable, and go only when sent or once each taken back is changed", async () => {
    const { questions, sent } = controller();
    await questions.ask("call-1", TWO, "main");
    await questions.answer({ id: "call-1:color", picked: [], typed: "Green" }, 0);
    await questions.answer({ id: "call-1:size", picked: [], typed: "Large" }, 0);
    expect(sent).toHaveLength(1);
    const notice = sent[0] as string;

    const reopened = await questions.reopen(notice, () => true);
    expect(
      reopened.map((record) => [record.questionId, record.answer?.typed, record.answer?.held]),
    ).toEqual([
      ["color", "Green", true],
      ["size", "Large", true],
    ]);
    // One changed, the other still as taken back: nothing goes yet.
    await questions.answer({ id: "call-1:color", picked: [], typed: "Blue" }, 0);
    expect(sent).toHaveLength(1);
    // Send answers sends both, the changed one as changed.
    const again = await questions.sendWaiting(0);
    expect(again.map((record) => record.answer?.typed)).toEqual(["Blue", "Large"]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Blue");
    expect(sent[1]).not.toContain("Green");
    expect(questions.list().every((record) => record.answer?.held !== true)).toBe(true);
  });

  test("are refused once omp has read them, and stay sent", async () => {
    const { questions, sent, entries } = controller();
    await questions.ask(
      "call-1",
      { questions: [{ id: "color", question: "Which color?" }] },
      "main",
    );
    await questions.answer({ id: "call-1:color", picked: [], typed: "Green" }, 0);
    const before = entries.length;
    await expect(questions.reopen(sent[0] as string, () => false)).rejects.toThrow(
      "omp has read these answers already",
    );
    expect(entries).toHaveLength(before);
    expect(questions.list()[0]?.answer?.held).toBeUndefined();
  });

  test("a message that carries no answers of this chat is refused", async () => {
    const { questions } = controller();
    await questions.ask(
      "call-1",
      { questions: [{ id: "color", question: "Which color?" }] },
      "main",
    );
    await expect(questions.reopen("some other text", () => true)).rejects.toThrow(
      "These answers are not this chat's",
    );
  });

  test("after Edit rewound the chat to just before them, they wait again without taking anything from the queue", async () => {
    const { questions, sent } = controller();
    await questions.ask(
      "call-1",
      { questions: [{ id: "color", question: "Which color?" }] },
      "main",
    );
    await questions.answer({ id: "call-1:color", picked: [], typed: "Green" }, 0);
    let taken = 0;
    const reopened = await questions.reopen(
      sent[0] as string,
      () => {
        taken++;
        return true;
      },
      true,
    );
    expect(reopened.map((record) => [record.answer?.typed, record.answer?.held])).toEqual([
      ["Green", true],
    ]);
    expect(taken).toBe(1);
    // A rewound chat that holds no sent answers of that text: nothing to take back, and no refusal.
    await expect(questions.reopen("not sent from here", () => true, true)).resolves.toHaveLength(1);
  });
});
