import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ThreadId, type TodoAuthor, type TodoBoard } from "@omp-app/contracts";
import { TodoRefused, TodoStore } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "todos-"));
  roots.push(root);
  return root;
}

const YOU: TodoAuthor = { kind: "person" };
const AGENT: TodoAuthor = {
  kind: "chat",
  threadId: ThreadId.parse("thread-1"),
  title: "Plan the week",
};

function open(root: string, clock = { now: 1_000 }): Promise<TodoStore> {
  let id = 0;
  return TodoStore.open(root, {
    now: () => clock.now,
    newId: () => {
      id += 1;
      return `item-${id}`;
    },
  });
}

describe("the to-do list", () => {
  test("keeps its items, order and lists in the file, and tells listeners each change", async () => {
    const root = await folder();
    const store = await open(root);
    const heard: TodoBoard[] = [];
    store.subscribe((board) => heard.push(board));
    const first = await store.add({ title: "Write the plan" }, YOU);
    await store.add({ title: "Read chapter 4", list: "School", due: "2026-11-12" }, AGENT);
    await store.add({ title: "Send the report" }, YOU);
    await store.move({ id: "item-3", before: first.id }, YOU);
    expect(heard.map((board) => board.revision)).toEqual([1, 2, 3, 4]);

    const again = (await open(root)).board();
    expect(again.items.map((item) => item.title)).toEqual([
      "Send the report",
      "Write the plan",
      "Read chapter 4",
    ]);
    expect(again.lists).toEqual(["To do", "School"]);
    expect(again.revision).toBe(4);
    expect(again.items[2]).toMatchObject({ list: "School", due: "2026-11-12", createdBy: AGENT });
  });

  test("done takes the time it was done; open again clears it; a change that changes nothing is not one", async () => {
    const clock = { now: 1_000 };
    const store = await open(await folder(), clock);
    const item = await store.add({ title: "Book the room" }, YOU);
    clock.now = 2_000;
    expect((await store.update({ id: item.id, state: "done" }, YOU)).doneAt).toBe(2_000);
    clock.now = 3_000;
    // Done again keeps the first time; a rename does not move it.
    expect((await store.update({ id: item.id, title: "Book room 2" }, YOU)).doneAt).toBe(2_000);
    expect((await store.update({ id: item.id, state: "open" }, YOU)).doneAt).toBeNull();
    const revision = store.board().revision;
    expect((await store.update({ id: item.id, state: "open" }, AGENT)).updatedBy).toEqual(YOU);
    expect(store.board().revision).toBe(revision);
  });

  test("the history names who changed what, newest first, and takes a change back while the item is as it left it", async () => {
    const store = await open(await folder());
    const item = await store.add({ title: "Draft the essay" }, YOU);
    await store.update({ id: item.id, state: "doing" }, AGENT);
    const [change] = store.history().changes;
    expect(change).toMatchObject({ action: "update", author: AGENT, title: "Draft the essay" });
    expect(change?.before?.state).toBe("open");

    await store.undo(change?.id ?? -1, YOU);
    expect(store.board().items[0]?.state).toBe("open");
    expect(store.history().changes[0]).toMatchObject({ action: "undo", author: YOU });

    // A later change to the item refuses taking an earlier one back.
    await store.update({ id: item.id, title: "Draft the essay, part 1" }, YOU);
    const rename = store.history().changes[0];
    await store.update({ id: item.id, notes: "Two pages" }, YOU);
    await expect(store.undo(rename?.id ?? -1, YOU)).rejects.toBeInstanceOf(TodoRefused);

    // A removal comes back; an add taken back goes.
    await store.remove(item.id, YOU);
    expect(store.board().items).toHaveLength(0);
    await store.undo(store.history().changes[0]?.id ?? -1, YOU);
    expect(store.board().items[0]?.notes).toBe("Two pages");
    const added = await store.add({ title: "Call the bank" }, AGENT);
    await store.undo(store.history().changes[0]?.id ?? -1, YOU);
    expect(store.board().items.map((each) => each.id)).not.toContain(added.id);
  });

  test("a move within its list only reorders, unkept by the history; a move to another list is kept and taken back", async () => {
    const store = await open(await folder());
    const a = await store.add({ title: "A" }, YOU);
    const b = await store.add({ title: "B" }, YOU);
    const kept = store.history().changes.length;
    await store.move({ id: b.id, before: a.id }, YOU);
    expect(store.board().items.map((item) => item.title)).toEqual(["B", "A"]);
    expect(store.history().changes).toHaveLength(kept);

    await store.move({ id: a.id, before: null, list: "Later" }, AGENT);
    expect(store.board().items[1]).toMatchObject({ title: "A", list: "Later", updatedBy: AGENT });
    await store.undo(store.history().changes[0]?.id ?? -1, YOU);
    expect(store.board().items[1]?.list).toBe("To do");
    await expect(store.move({ id: a.id, before: "nothing" }, YOU)).rejects.toBeInstanceOf(
      TodoRefused,
    );
  });

  test("refuses a 41st list and an item that is gone, in words", async () => {
    const store = await open(await folder());
    for (let index = 1; index < 40; index += 1)
      await store.add({ title: "x", list: `L${index}` }, YOU);
    await store.add({ title: "x" }, YOU);
    await expect(store.add({ title: "y", list: "One more" }, YOU)).rejects.toThrow(
      "There are 40 lists at most",
    );
    await expect(store.update({ id: "gone", title: "z" }, YOU)).rejects.toThrow(
      "That item is not in the list",
    );
  });

  test("a file it cannot read is moved aside, and the list starts empty", async () => {
    const root = await folder();
    await writeFile(join(root, "todos.json"), "{ not json");
    const moved: string[] = [];
    const store = await TodoStore.open(root, { onUnreadable: (to) => moved.push(to) });
    expect(store.board().items).toEqual([]);
    expect(moved).toHaveLength(1);
    expect(
      (await readdir(root)).filter((name) => name.startsWith("todos.unreadable-")),
    ).toHaveLength(1);
  });
});
