import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QuestionRecord } from "@omp-app/contracts/chat-host";
import { readWaitingQuestions } from "./open-questions";

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

function asked(id: string, answer: QuestionRecord["answer"] = null): QuestionRecord {
  return {
    id,
    toolCallId: `call-${id}`,
    questionId: id,
    question: `Question ${id}?`,
    options: [{ label: "Yes" }, { label: "No" }],
    multi: false,
    askedAt: 1,
    answer,
  };
}

describe("the questions kept before Workbench", () => {
  test("are read as each chat's open and held questions; a sent one is left out, and so is a chat with none", async () => {
    const root = await folder();
    await writeFile(
      join(root, "questions.json"),
      JSON.stringify({
        version: 1,
        scanned: true,
        chats: {
          "chat-a": {
            folder: "/work",
            records: [
              asked("open"),
              asked("held", { picked: ["Yes"], skipped: false, answeredAt: 2, held: true }),
              asked("sent", { picked: ["No"], skipped: false, answeredAt: 2, sentAt: 3 }),
            ],
          },
          "chat-b": {
            folder: null,
            records: [asked("done", { picked: [], skipped: true, answeredAt: 2, sentAt: 3 })],
          },
        },
      }),
    );
    const read = await readWaitingQuestions(root);
    expect(read?.file).toBe(join(root, "questions.json"));
    expect(
      read?.chats.map((chat) => [String(chat.threadId), chat.records.map((record) => record.id)]),
    ).toEqual([["chat-a", ["open", "held"]]]);
  });

  test("give nothing when there is no list, and an empty list when it cannot be read", async () => {
    const root = await folder();
    expect(await readWaitingQuestions(root)).toBeNull();
    await writeFile(join(root, "questions.json"), "not json");
    expect((await readWaitingQuestions(root))?.chats).toEqual([]);
  });
});
