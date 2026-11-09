import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, ThreadId } from "@omp-app/contracts";
import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { OpenQuestions, scanSessionQuestions, waitingQuestionsIn } from "./open-questions";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "questions-"));
  roots.push(root);
  return root;
}

const A = ThreadId.parse("thread-a");
const B = ThreadId.parse("thread-b");
const WORK = FolderPath.parse("/work/app");

function asked(id: string, askedAt: number): QuestionRecord {
  return {
    id,
    toolCallId: `call-${id}`,
    questionId: id,
    question: `Question ${id}?`,
    options: [{ label: "Yes" }, { label: "No" }],
    multi: false,
    askedAt,
    answer: null,
  };
}

const held = (record: QuestionRecord): QuestionRecord => ({
  ...record,
  answer: { picked: ["Yes"], skipped: false, answeredAt: 5, held: true },
});
const sent = (record: QuestionRecord): QuestionRecord => ({
  ...record,
  answer: { picked: ["Yes"], skipped: false, answeredAt: 5, sentAt: 6 },
});

describe("every chat's questions that wait", () => {
  test("a question waits while open or held, leaves once sent, and the list outlives a restart, newest chat first", async () => {
    const root = await folder();
    const questions = await OpenQuestions.open(root);
    let heard = 0;
    questions.subscribe(() => {
      heard += 1;
    });
    questions.record(A, WORK, asked("a1", 1));
    questions.record(A, WORK, asked("a2", 2));
    questions.record(B, null, asked("b1", 3));
    questions.record(A, WORK, held(asked("a1", 1)));
    expect(
      questions.list().map((chat) => [String(chat.threadId), chat.records.map((r) => r.id)]),
    ).toEqual([
      ["thread-b", ["b1"]],
      ["thread-a", ["a1", "a2"]],
    ]);
    // Both of the chat's answers went: the chat leaves the list.
    questions.record(A, WORK, sent(asked("a1", 1)));
    questions.record(A, WORK, sent(asked("a2", 2)));
    expect(questions.list().map((chat) => String(chat.threadId))).toEqual(["thread-b"]);
    expect(heard).toBe(6);
    // A record the list never had, sent, changes nothing.
    questions.record(B, null, sent(asked("old", 0)));
    expect(heard).toBe(6);

    await questions.settled();
    const again = await OpenQuestions.open(root);
    expect(again.list()).toEqual([{ threadId: B, folder: null, records: [asked("b1", 3)] }]);
    again.dismiss(B);
    expect(again.list()).toEqual([]);
  });

  test("a session file's waiting questions are read as its chat reads them; the first scan runs once", async () => {
    const lines = [
      { type: "title", v: 1, title: "Plan" },
      { type: "session", id: "thread-s", cwd: "/work/app" },
      {
        type: "custom",
        customType: "omp-app/question",
        data: { ...asked("q1", 1), answer: undefined },
      },
      {
        type: "custom",
        customType: "omp-app/question",
        data: { ...asked("q2", 2), answer: undefined },
      },
      {
        type: "custom",
        customType: "omp-app/question",
        data: { ...asked("q3", 3), answer: undefined },
      },
      {
        type: "custom",
        customType: "omp-app/question-answer",
        data: { id: "q1", picked: ["No"], skipped: false, answeredAt: 4, held: true },
      },
      {
        type: "custom",
        customType: "omp-app/question-answer",
        data: { id: "q2", picked: ["Yes"], skipped: false, answeredAt: 4, held: true },
      },
      { type: "custom", customType: "omp-app/question-sent", data: { ids: ["q2"], sentAt: 5 } },
    ];
    const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    const read = waitingQuestionsIn(text);
    expect(read.threadId).toBe("thread-s");
    expect(read.folder).toBe("/work/app");
    expect(read.records.map((record) => [record.id, record.answer?.held ?? null])).toEqual([
      ["q1", true],
      ["q3", null],
    ]);

    const root = await folder();
    const sessions = join(root, "sessions", "-work-app");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "new.jsonl"), text);
    await writeFile(join(sessions, "plain.jsonl"), `${JSON.stringify(lines[1])}\n`);
    await writeFile(join(sessions, "old.jsonl"), text.replace("thread-s", "thread-old"));
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await utimes(join(sessions, "old.jsonl"), longAgo, longAgo);
    const since = Date.now() - 30 * 86_400_000;
    const found = await scanSessionQuestions(async () => [sessions], since);
    expect(found.map((chat) => String(chat.threadId))).toEqual(["thread-s"]);

    const questions = await OpenQuestions.open(root);
    let scans = 0;
    const scan = async () => {
      scans += 1;
      return found;
    };
    await questions.scanOnce(scan);
    expect(questions.list()[0]?.records.map((record) => record.id)).toEqual(["q1", "q3"]);
    await questions.settled();
    await (await OpenQuestions.open(root)).scanOnce(scan);
    expect(scans).toBe(1);
  });
});
