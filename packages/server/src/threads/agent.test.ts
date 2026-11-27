import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, ThreadId, WorkThreadId } from "@omp-app/contracts";
import type { ToolCallAnswer } from "@omp-app/contracts/chat-host";
import { answerThreadCall } from "./agent";
import { WorkThreadStore } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const OWNER = {
  threadId: ThreadId.parse("chat-owner"),
  folder: FolderPath.parse("/work"),
  title: "omp-app",
};
const OTHER = {
  threadId: ThreadId.parse("chat-other"),
  folder: FolderPath.parse("/work"),
  title: null,
};

async function setup() {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "threads-agent-"));
  roots.push(root);
  let id = 0;
  const store = await WorkThreadStore.open(root, {
    newId: () => {
      id += 1;
      return `thread${id}`;
    },
  });
  const call = (chat: typeof OWNER | typeof OTHER, tool: string, params: unknown, agent = "main") =>
    answerThreadCall(store, chat, { tool, agent, params });
  return { store, call };
}

const words = (answer: ToolCallAnswer): string =>
  answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

describe("Workbench's tools, as the server answers them", () => {
  test("a thread an agent opens is its chat's, and its updates, state and links read back in its timeline", async () => {
    const { store, call } = await setup();
    const opened = await call(OWNER, "thread_open", {
      title: "Slow new chat",
      kind: "bug",
      text: "30 s to list",
    });
    expect(opened.isError).toBeUndefined();
    expect(words(opened)).toContain("Opened thread thread1");
    const id = WorkThreadId.parse("thread1");
    expect(store.read(id)?.summary).toMatchObject({
      owner: OWNER.threadId,
      createdBy: { kind: "chat", threadId: OWNER.threadId, title: "omp-app" },
    });

    await call(OWNER, "thread_update", { id, text: "Found it", progress: { done: 1, total: 3 } });
    await call(OWNER, "thread_state", { id, state: "in_progress" });
    await call(OWNER, "thread_link", { id, kind: "commit", sha: "6d3db1dc2" });
    await call(OWNER, "thread_link", {
      id,
      kind: "issue",
      url: "https://github.com/o/r/issues/98",
    });
    expect(store.read(id)?.summary).toMatchObject({
      state: "in_progress",
      progress: { done: 1, total: 3 },
    });

    const timeline = words(await call(OTHER, "thread_read", { id }));
    expect(timeline).toContain(
      'thread1 [in_progress, 1/3] bug: "Slow new chat", owner chat chat-owner',
    );
    expect(timeline).toContain('chat chat-owner "omp-app" update (1/3):\nFound it');
    expect(timeline).toContain('link: {"kind":"commit","sha":"6d3db1dc2"}');
    const list = words(await call(OWNER, "thread_read", {}));
    expect(list).toBe(
      '1 thread(s):\n- thread1 [in_progress, 1/3] bug: "Slow new chat", owner this chat',
    );
    expect(words(await call(OWNER, "thread_read", { state: "done" }))).toBe("No threads.");
  });

  test("only the owner asks, a subagent only reads, and a call that does not fit is refused in words", async () => {
    const { store, call } = await setup();
    await call(OWNER, "thread_open", { title: "Voice", kind: "feature", text: "plan" });
    const id = "thread1";

    const asked = await call(OWNER, "thread_ask", {
      id,
      questions: [
        {
          id: "go",
          question: "Approve?",
          options: [{ label: "Yes" }, { label: "No" }],
          recommended: 0,
        },
      ],
    });
    expect(words(asked)).toContain("Asked in thread thread1 (ask e2)");
    expect(store.read(WorkThreadId.parse(id))?.summary.unanswered).toBe(1);

    const notOwner = await call(OTHER, "thread_ask", {
      id,
      questions: [{ id: "q", question: "Mine?" }],
    });
    expect(notOwner.isError).toBe(true);
    expect(words(notOwner)).toContain("only the chat that owns a thread asks in it");

    const sub = await call(OWNER, "thread_update", { id, text: "from a subagent" }, "sub");
    expect(sub.isError).toBe(true);
    expect(words(sub)).toContain("A subagent only reads");
    expect((await call(OWNER, "thread_read", { id }, "sub")).isError).toBeUndefined();

    const badState = await call(OWNER, "thread_state", { id, state: "finished" });
    expect(badState.isError).toBe(true);
    expect(words(badState)).toContain("state");
    const badLink = await call(OWNER, "thread_link", { id, kind: "commit", sha: "not a sha" });
    expect(badLink.isError).toBe(true);
    const missing = await call(OWNER, "thread_update", { id: "nothread9", text: "x" });
    expect(words(missing)).toBe("There is no thread nothread9; thread_read lists them.");
    const empty = await call(OWNER, "thread_open", { title: "", kind: "bug", text: "x" });
    expect(empty.isError).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});
