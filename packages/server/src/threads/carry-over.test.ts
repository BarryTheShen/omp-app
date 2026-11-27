import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, ThreadId } from "@omp-app/contracts";
import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { carryOverQuestions } from "./carry-over";
import { WorkThreadStore } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const A = ThreadId.parse("chat-a");
const B = ThreadId.parse("chat-b");
const folder = FolderPath.parse("/work");

function record(
  toolCallId: string,
  questionId: string,
  askedAt: number,
  extra: Partial<QuestionRecord> = {},
): QuestionRecord {
  return {
    id: `${toolCallId}:${questionId}`,
    toolCallId,
    questionId,
    question: `Question ${questionId}?`,
    options: [{ label: "Yes" }, { label: "No" }],
    multi: false,
    askedAt,
    answer: null,
    ...extra,
  };
}

describe("carrying ask_async questions into Workbench", () => {
  test("makes a thread per chat, an ask per call, keeps held answers, and moves the old list aside", async () => {
    await Bun.write(join(DATA, ".keep"), "");
    const root = await mkdtemp(join(DATA, "carry-over-"));
    roots.push(root);
    const listFile = join(root, "questions.json");
    await writeFile(listFile, "{}\n");
    const store = await WorkThreadStore.open(root);

    const made = await carryOverQuestions(
      store,
      [
        {
          threadId: A,
          folder,
          records: [
            record("call-2", "later", 20),
            record("call-1", "first", 10, {
              answer: {
                picked: ["No"],
                note: "not now",
                skipped: false,
                answeredAt: 15,
                held: true,
              },
            }),
            record("call-1", "second", 11),
          ],
        },
        {
          threadId: B,
          folder,
          records: [
            record("call-9", "dup", 30, { options: [{ label: "Same" }, { label: "Same" }] }),
          ],
        },
      ],
      async (threadId) => (threadId === A ? "Voice plan" : null),
      listFile,
    );

    expect(made).toBe(2);
    const threads = store.list();
    const a = threads.find((thread) => thread.owner === A);
    const b = threads.find((thread) => thread.owner === B);
    expect(a).toMatchObject({
      title: "Questions from Voice plan",
      kind: "question",
      createdBy: { kind: "app" },
    });
    // call-1 asked first: its ask comes first; its held answer is kept, so "second" and "later" wait.
    expect(a?.unanswered).toBe(2);
    const entries = store.read(a?.id ?? ("" as never))?.entries ?? [];
    expect(
      entries
        .filter((entry) => entry.type === "question")
        .map((entry) => entry.type === "question" && entry.questions.map((q) => q.id)),
    ).toEqual([["first", "second"], ["later"]]);
    expect(entries.find((entry) => entry.type === "answer")).toMatchObject({
      questionId: "first",
      answer: { picked: ["No"], note: "not now", skipped: false },
      by: { kind: "person" },
    });
    // An ask the thread cannot take as questions is kept as words.
    expect(b).toMatchObject({ title: "Questions from a chat", unanswered: 0 });
    expect(b?.last?.text).toContain("Carried over as text:\n- Question dup? (dup)");

    expect((await readdir(root)).filter((name) => name.startsWith("questions.json"))).toEqual([
      "questions.json.migrated",
    ]);
  });
});
