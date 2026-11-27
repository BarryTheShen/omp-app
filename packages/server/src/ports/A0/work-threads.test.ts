import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppFailure,
  FolderPath,
  splitAppNotice,
  type TaskTarget,
  ThreadId,
  type WorkThreadSummary,
} from "@omp-app/contracts";
import { WorkThreadStore } from "../../threads/store";
import { createWorkThreadsRuntime } from "./work-threads";

const DATA = join(import.meta.dir, "../../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CHAT = ThreadId.parse("chat-owner");
const MAIN = ThreadId.parse("chat-main");
const NEW = ThreadId.parse("chat-new");

interface Sent {
  readonly target: TaskTarget;
  readonly source: string | undefined;
  readonly text: string;
}

async function setup(options: { failDelivery?: boolean } = {}) {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "threads-port-"));
  roots.push(root);
  let id = 0;
  const store = await WorkThreadStore.open(root, {
    newId: () => {
      id += 1;
      return `thread${id}`;
    },
  });
  const sent: Sent[] = [];
  const events: unknown[] = [];
  const runtime = createWorkThreadsRuntime({
    store,
    publish: (_stream, payload) => events.push(payload),
    deliver: async (target, text) => {
      if (options.failDelivery === true) throw new Error("the chat could not be opened");
      const notice = splitAppNotice(text);
      sent.push({ target, source: notice?.source, text: notice?.text ?? text });
      return target.kind === "chat" ? target.threadId : NEW;
    },
  });
  const handlers = runtime.registration.handlers as Record<string, (args: unknown) => unknown>;
  const call = <T>(method: string, args: unknown): Promise<T> =>
    Promise.resolve().then(() => handlers[method]?.(args) as T);
  return { store, sent, events, call };
}

async function failure(work: Promise<unknown>): Promise<AppFailure> {
  const caught = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(AppFailure);
  return caught as AppFailure;
}

describe("Workbench's port", () => {
  test("hands a thread the person opens to the chat they picked, as a notice naming the thread", async () => {
    const { sent, events, call } = await setup();
    const thread = await call<WorkThreadSummary>("open", {
      title: "Slow new chat",
      kind: "bug",
      text: "It takes 30 s to show",
      to: { kind: "chat", threadId: CHAT },
    });
    expect(thread.owner).toBe(CHAT);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({ kind: "chat", threadId: CHAT });
    expect(sent[0]?.source).toBe("thread");
    expect(sent[0]?.text).toContain(`Thread ${thread.id} "Slow new chat" (bug)`);
    expect(sent[0]?.text).toContain("It takes 30 s to show");
    expect(events).toEqual([{ id: thread.id, at: expect.any(Number) }]);
  });

  test("opens for the main chat only once one is set, and for a new chat records the chat that took it", async () => {
    const { sent, call, store } = await setup();
    const refused = await failure(
      call("open", { title: "T", kind: "task", text: "x", to: { kind: "main" } }),
    );
    expect(refused.appError.code).toBe("invalid_args");
    expect(store.list()).toHaveLength(0);

    await call("setMainChat", { threadId: MAIN });
    const forMain = await call<WorkThreadSummary>("open", {
      title: "T",
      kind: "task",
      text: "x",
      to: { kind: "main" },
    });
    expect(forMain.owner).toBe(MAIN);
    expect(sent.at(-1)?.target).toEqual({ kind: "chat", threadId: MAIN });

    const folder = FolderPath.parse("/work/project");
    const forNew = await call<WorkThreadSummary>("open", {
      title: "N",
      kind: "feature",
      text: "y",
      to: { kind: "new", folder },
    });
    expect(sent.at(-1)?.target).toEqual({ kind: "new", folder });
    expect(forNew.owner).toBe(NEW);
    expect(store.read(forNew.id)?.entries.at(-1)).toMatchObject({
      type: "owner",
      by: { kind: "app" },
    });
  });

  test("sends what the person writes to the owner, else the main chat, and keeps it when no chat is there", async () => {
    const { sent, call, store } = await setup();
    const owned = await store.open(
      { title: "Owned", kind: "task", text: "a", owner: CHAT },
      { kind: "person" },
    );
    await call("message", { id: owned.id, text: "Any news?" });
    expect(sent.at(-1)).toMatchObject({
      target: { kind: "chat", threadId: CHAT },
      source: "thread",
    });
    expect(sent.at(-1)?.text).toContain("the person wrote:\n\nAny news?");

    const loose = await store.open(
      { title: "Loose", kind: "task", text: "b", owner: null },
      { kind: "person" },
    );
    const before = sent.length;
    await call("message", { id: loose.id, text: "kept" });
    expect(sent).toHaveLength(before);
    expect(store.read(loose.id)?.summary.last?.text).toBe("kept");

    await call("setMainChat", { threadId: MAIN });
    await call("message", { id: loose.id, text: "now to main" });
    expect(sent.at(-1)?.target).toEqual({ kind: "chat", threadId: MAIN });
  });

  test("sends an ask's answers together once each question has one, skips left out, and takes no answer after", async () => {
    const { sent, call, store } = await setup();
    const thread = await store.open(
      { title: "Voice", kind: "feature", text: "plan", owner: CHAT },
      { kind: "person" },
    );
    const { entry: ask } = await store.post(
      thread.id,
      {
        type: "question",
        questions: [
          {
            id: "plan",
            question: "Approve the plan?",
            header: "Plan",
            options: [{ label: "Approve" }, { label: "Not yet" }],
            multi: false,
          },
          {
            id: "gpu",
            question: "If the GPU is short?",
            options: [{ label: "0.6B" }, { label: "Kokoro" }],
            multi: false,
          },
          { id: "else", question: "Anything else?", options: [], multi: false },
        ],
      },
      { kind: "chat", threadId: CHAT, title: "omp-app" },
    );
    const answer = (questionId: string, value: object) =>
      call<WorkThreadSummary>("answer", {
        id: thread.id,
        ask: ask.id,
        questionId,
        answer: { picked: [], skipped: false, ...value },
      });

    await answer("plan", { picked: ["Not yet"], note: "after Workbench" });
    await answer("gpu", { picked: ["Kokoro"] });
    expect(sent).toHaveLength(0);
    const done = await answer("else", { skipped: true });
    expect(done.unanswered).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(
      [
        `Thread ${thread.id} "Voice": the person's answers to your questions:`,
        "",
        '"Plan" (plan):\nNot yet\nNote: after Workbench',
        "",
        '"If the GPU is short?" (gpu):\nKokoro',
      ].join("\n"),
    );
    expect((await failure(answer("plan", { picked: ["Approve"] }))).appError.code).toBe(
      "invalid_args",
    );
  });

  test("sends the answers ready so far when asked, and the rest later", async () => {
    const { sent, call, store } = await setup();
    const thread = await store.open(
      { title: "Two", kind: "task", text: "x", owner: CHAT },
      { kind: "person" },
    );
    const { entry: ask } = await store.post(
      thread.id,
      {
        type: "question",
        questions: [
          { id: "a", question: "A?", options: [], multi: false },
          { id: "b", question: "B?", options: [], multi: false },
        ],
      },
      { kind: "app" },
    );
    await call("answer", {
      id: thread.id,
      ask: ask.id,
      questionId: "a",
      answer: { picked: [], typed: "yes", skipped: false },
    });
    await call("sendAnswers", { id: thread.id, ask: ask.id });
    expect(sent.map((one) => one.text.split("\n").at(-1))).toEqual(["yes"]);
    await call("answer", {
      id: thread.id,
      ask: ask.id,
      questionId: "b",
      answer: { picked: [], typed: "no", skipped: false },
    });
    expect(sent.map((one) => one.text.split("\n").at(-1))).toEqual(["yes", "no"]);
    expect((await failure(call("sendAnswers", { id: thread.id, ask: ask.id }))).appError.code).toBe(
      "invalid_args",
    );
  });

  test("tells the chat a thread is handed to, and keeps the person's words when no chat can be reached", async () => {
    const { sent, call, store } = await setup();
    const thread = await store.open(
      { title: "Relay", kind: "feature", text: "x", owner: CHAT },
      { kind: "person" },
    );
    const other = ThreadId.parse("chat-other");
    await call("setOwner", { id: thread.id, owner: other });
    expect(sent.at(-1)?.target).toEqual({ kind: "chat", threadId: other });
    expect(sent.at(-1)?.text).toContain(
      `Thread ${thread.id} "Relay" (feature, open) is now this chat's.`,
    );

    const broken = await setup({ failDelivery: true });
    const kept = await broken.store.open(
      { title: "Kept", kind: "task", text: "x", owner: CHAT },
      { kind: "person" },
    );
    const caught = await failure(broken.call("message", { id: kept.id, text: "still here" }));
    expect(caught.appError.code).toBe("unavailable");
    expect(caught.message).toContain("Kept in the thread");
    expect(broken.store.read(kept.id)?.summary.last?.text).toBe("still here");
    expect((await failure(call("read", { id: "nothread9" }))).appError.code).toBe("not_found");
  });
});
