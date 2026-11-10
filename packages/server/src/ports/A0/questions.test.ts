import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, QuestionsPort, streamKey, ThreadId } from "@omp-app/contracts";
import type { OmpQuestionRequest, QuestionRecord } from "@omp-app/contracts/chat-host";
import { OpenQuestions } from "../../questions/open-questions";
import type { WaitingAsks } from "./chat-session";
import { createQuestionsRuntime } from "./questions";

const DATA = join(import.meta.dir, "../../../../../.data");
const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

const confirm = (id: string): OmpQuestionRequest => ({
  id,
  method: "ui.confirm",
  params: { title: "Deploy?", message: "Deploy the build now?" },
});
const pick = (id: string): OmpQuestionRequest => ({
  id,
  method: "ui.select",
  params: { title: "Which branch?", options: ["main", "next"] },
});

/** The runtime over a real list of asked questions and omp's questions as given; what it published, and its list. */
async function runtime(asks: () => readonly WaitingAsks[]): Promise<{
  readonly questions: OpenQuestions;
  readonly published: unknown[];
  readonly waitingChanged: () => void;
  readonly list: () => Promise<unknown>;
}> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "questions-runtime-"));
  roots.push(root);
  const questions = await OpenQuestions.open(root);
  const published: unknown[] = [];
  const listeners = new Set<() => void>();
  const made = createQuestionsRuntime({
    questions,
    waiting: {
      asks,
      onWaitingChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    titleOf: async (threadId) => (threadId === A ? "Chat A" : null),
    publish: (stream, payload) => published.push([stream, payload]),
    now: () => 7,
  });
  stops.push(made.stop);
  const handlers = made.registration.handlers as { list: () => Promise<unknown> };
  return {
    questions,
    published,
    waitingChanged: () => {
      for (const listener of listeners) listener();
    },
    list: () => handlers.list(),
  };
}

describe("the dashboard's questions", () => {
  test("omp's questions that stop a chat are listed with the chat's own, the chat asked most recently first", async () => {
    let asks: readonly WaitingAsks[] = [
      { threadId: B, folder: WORK, requests: [confirm("r-b")], at: 300 },
      { threadId: A, folder: WORK, requests: [pick("r-a")], at: 50 },
    ];
    const { questions, list } = await runtime(() => asks);
    questions.record(A, WORK, asked("a1", 100));
    expect(await list()).toEqual({
      chats: [
        { threadId: B, folder: WORK, title: null, records: [], requests: [confirm("r-b")] },
        {
          threadId: A,
          folder: WORK,
          title: "Chat A",
          records: [asked("a1", 100)],
          requests: [pick("r-a")],
        },
      ],
    });
    // omp's question answered: the chat stays for its own question, and the order follows that one's time.
    asks = [{ threadId: B, folder: WORK, requests: [confirm("r-b")], at: 20 }];
    expect(await list()).toEqual({
      chats: [
        {
          threadId: A,
          folder: WORK,
          title: "Chat A",
          records: [asked("a1", 100)],
          requests: [],
        },
        { threadId: B, folder: WORK, title: null, records: [], requests: [confirm("r-b")] },
      ],
    });
  });

  test("a change in omp's questions goes out as one changed to every device", async () => {
    const { published, waitingChanged } = await runtime(() => []);
    waitingChanged();
    waitingChanged();
    await Bun.sleep(250);
    expect(published).toEqual([[streamKey(QuestionsPort.name, "changed"), { at: 7 }]]);
  });
});
