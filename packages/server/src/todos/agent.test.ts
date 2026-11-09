import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, ThreadId } from "@omp-app/contracts";
import { answerAgentCall, type CallingChat } from "./agent";
import { TodoStore } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(): Promise<TodoStore> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "todos-agent-"));
  roots.push(root);
  let id = 0;
  return TodoStore.open(root, {
    newId: () => {
      id += 1;
      return `item-${id}`;
    },
  });
}

const CHAT: CallingChat = {
  threadId: ThreadId.parse("thread-7"),
  folder: FolderPath.parse("/work/app"),
  title: "Plan the week",
};

const text = (answer: { content: readonly { type: string; text?: string }[] }): string =>
  answer.content.map((part) => part.text ?? "").join("");

describe("a chat's agent and the to-do list", () => {
  test("the chat's agent adds, starts and drops items, each change in its chat's name and linked to it", async () => {
    const list = await store();
    const added = await answerAgentCall(list, CHAT, {
      agent: "main",
      action: "add",
      title: "Write the release notes",
      list: "omp-app",
      due: "2026-11-12",
    });
    expect(added.isError).toBeUndefined();
    expect(text(added)).toBe('Added "Write the release notes" to the list "omp-app" (id item-1).');
    expect(list.board().items[0]).toMatchObject({
      list: "omp-app",
      due: "2026-11-12",
      createdBy: { kind: "chat", threadId: "thread-7", title: "Plan the week" },
      chat: { threadId: "thread-7", folder: "/work/app", title: "Plan the week" },
    });

    await answerAgentCall(list, CHAT, {
      agent: "main",
      action: "update",
      id: "item-1",
      state: "doing",
    });
    expect(list.board().items[0]?.state).toBe("doing");

    // Dropped, not deleted: it stays, out of the way, and the person can take the drop back.
    const dropped = await answerAgentCall(list, CHAT, {
      agent: "main",
      action: "drop",
      id: "item-1",
    });
    expect(text(dropped)).toContain("The user can bring it back");
    expect(list.board().items[0]?.state).toBe("dropped");
    await list.undo(list.history().changes[0]?.id ?? -1, { kind: "person" });
    expect(list.board().items[0]?.state).toBe("doing");
  });

  test("the list reads by list, in order, with ids and marks; done ones only when asked", async () => {
    const list = await store();
    await list.add(
      { title: "Plan the dashboard", list: "omp-app", state: "doing" },
      { kind: "person" },
    );
    await list.add(
      { title: "Read chapter 4", list: "School", notes: "Pages 80 to 95" },
      { kind: "person" },
    );
    await list.add({ title: "Old task", list: "omp-app", state: "done" }, { kind: "person" });
    const read = text(await answerAgentCall(list, CHAT, { agent: "sub", action: "list" }));
    expect(read).toBe(
      [
        "2 to do (1 doing). By list, in order:",
        "",
        "omp-app",
        "- [doing] Plan the dashboard · id item-1",
        "",
        "School",
        "- [ ] Read chapter 4 · id item-2",
        "  notes: Pages 80 to 95",
      ].join("\n"),
    );
    const all = text(
      await answerAgentCall(list, CHAT, { agent: "main", action: "list", includeDone: true }),
    );
    expect(all).toContain("- [x] Old task · id item-3");
  });

  test("a subagent only reads, and a call the list cannot take changes nothing and says why", async () => {
    const list = await store();
    const sub = await answerAgentCall(list, CHAT, { agent: "sub", action: "add", title: "Sneaky" });
    expect(sub.isError).toBe(true);
    expect(text(sub)).toContain("Subagents can only list");
    const long = await answerAgentCall(list, CHAT, {
      agent: "main",
      action: "add",
      title: "x".repeat(201),
    });
    expect(long.isError).toBe(true);
    expect(text(long)).toContain("title");
    const gone = await answerAgentCall(list, CHAT, {
      agent: "main",
      action: "drop",
      id: "nothing",
    });
    expect(text(gone)).toContain("not in the list");
    const garbled = await answerAgentCall(list, CHAT, { agent: "main", action: "explode" });
    expect(garbled.isError).toBe(true);
    expect(list.board().items).toEqual([]);
    expect(list.board().revision).toBe(0);
  });
});
