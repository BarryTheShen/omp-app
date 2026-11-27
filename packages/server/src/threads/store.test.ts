import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ThreadId,
  type WorkThreadAuthor,
  WorkThreadId,
  type WorkThreadPost,
} from "@omp-app/contracts";
import { WorkThreadRefused, WorkThreadStore } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "threads-"));
  roots.push(root);
  return root;
}

const YOU: WorkThreadAuthor = { kind: "person" };
const CHAT = ThreadId.parse("chat-1");
const AGENT: WorkThreadAuthor = { kind: "chat", threadId: CHAT, title: "omp-app" };

function open(root: string, clock = { now: 1_000 }): Promise<WorkThreadStore> {
  let id = 0;
  return WorkThreadStore.open(root, {
    now: () => clock.now,
    newId: () => {
      id += 1;
      return `thread${id}`;
    },
  });
}

const ASK: WorkThreadPost = {
  type: "question",
  questions: [
    {
      id: "order",
      question: "Build it before or after?",
      options: [{ label: "Before" }, { label: "After" }],
      multi: false,
      recommended: 1,
    },
    { id: "why", question: "Anything to change?", options: [], multi: false },
  ],
};

describe("Workbench threads", () => {
  test("keep their timeline in their files, read back the same after a restart, newest activity first", async () => {
    const root = await folder();
    const clock = { now: 1_000 };
    const store = await open(root, clock);
    const relay = await store.open(
      { title: "Browser relay", kind: "feature", text: "Drive the laptop's browser", owner: CHAT },
      AGENT,
    );
    clock.now = 2_000;
    const slow = await store.open(
      { title: "Slow new chat", kind: "bug", text: "It takes 30 s", owner: null },
      YOU,
    );
    clock.now = 3_000;
    await store.post(
      relay.id,
      {
        type: "update",
        text: "M3 done",
        progress: { done: 3, total: 4, steps: ["a", "b", "c", "d"] },
      },
      AGENT,
    );
    await store.post(relay.id, { type: "link", link: { kind: "commit", sha: "c3f173da8" } }, AGENT);
    await store.post(relay.id, { type: "link", link: { kind: "commit", sha: "c3f173da8" } }, AGENT);
    clock.now = 4_000;
    await store.post(slow.id, { type: "state", state: "in_progress" }, AGENT);
    await store.post(slow.id, { type: "owner", owner: CHAT }, AGENT);

    const listed = store.list();
    expect(listed.map((thread) => thread.title)).toEqual(["Slow new chat", "Browser relay"]);
    expect(listed[0]).toMatchObject({
      state: "in_progress",
      owner: CHAT,
      updatedAt: 4_000,
      entries: 3,
    });
    expect(listed[0]?.last).toEqual({ type: "created", text: "It takes 30 s", at: 2_000 });
    expect(listed[1]).toMatchObject({
      progress: { done: 3, total: 4 },
      links: [{ kind: "commit", sha: "c3f173da8" }],
      last: { type: "update", text: "M3 done", at: 3_000 },
      entries: 4,
    });

    const again = await open(root);
    expect(again.list()).toEqual(listed);
    expect(again.read(relay.id)?.entries).toEqual(store.read(relay.id)?.entries ?? []);
    expect(again.read(relay.id)?.entries.map((entry) => entry.id)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
  });

  test("drop a last line cut short, so the next entry is a line of its own and reads back", async () => {
    const root = await folder();
    const store = await open(root);
    const thread = await store.open(
      { title: "Torn", kind: "task", text: "first", owner: null },
      YOU,
    );
    await store.post(thread.id, { type: "message", text: "second" }, YOU);
    const path = join(store.folder, `${thread.id}.jsonl`);
    await appendFile(path, '{"id":"e3","at":5,"by":{"kind":"person"},"type":"mess');

    const reopened = await open(root);
    expect(reopened.read(thread.id)?.summary.entries).toBe(2);
    expect((await readFile(path, "utf8")).endsWith("}\n")).toBe(true);
    await reopened.post(thread.id, { type: "message", text: "third" }, YOU);

    const third = await open(root);
    expect(
      third.read(thread.id)?.entries.map((entry) => entry.type === "message" && entry.text),
    ).toEqual([false, "second", "third"]);
  });

  test("skip a line they cannot read and a file that does not start with its opening", async () => {
    const root = await folder();
    const store = await open(root);
    const thread = await store.open(
      { title: "Kept", kind: "task", text: "first", owner: null },
      YOU,
    );
    await appendFile(join(store.folder, `${thread.id}.jsonl`), "not json\n");
    await store.settled();
    await writeFile(
      join(store.folder, "headless1.jsonl"),
      `${JSON.stringify({ id: "e1", at: 1, by: YOU, type: "message", text: "no opening" })}\n`,
    );
    const reopened = await open(root);
    expect(reopened.list().map((summary) => summary.title)).toEqual(["Kept"]);
    await reopened.post(thread.id, { type: "message", text: "after" }, YOU);
    expect(reopened.read(thread.id)?.summary.entries).toBe(2);
  });

  test("count the questions that wait, take answers until they are sent, and refuse what does not fit", async () => {
    const root = await folder();
    const store = await open(root);
    const thread = await store.open(
      { title: "Voice", kind: "feature", text: "plan", owner: CHAT },
      AGENT,
    );
    const { entry: ask } = await store.post(thread.id, ASK, AGENT);
    expect(store.read(thread.id)?.summary.unanswered).toBe(2);
    expect(store.read(thread.id)?.summary.last).toMatchObject({
      type: "question",
      text: "Build it before or after?",
    });

    const answer = (questionId: string, picked: string[], extra: object = {}) =>
      store.post(
        thread.id,
        { type: "answer", ask: ask.id, questionId, answer: { picked, skipped: false, ...extra } },
        YOU,
      );
    const refused = async (change: Promise<unknown>, words: string) => {
      const error = await change.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WorkThreadRefused);
      expect((error as Error).message).toContain(words);
    };

    await refused(answer("order", ["Sideways"]), 'no choice "Sideways"');
    await refused(answer("order", ["Before", "After"]), "takes one choice");
    await refused(answer("nope", ["Before"]), 'no question "nope"');
    await refused(answer("why", []), "is empty");
    await refused(
      store.post(thread.id, { type: "sent", ask: ask.id, questionIds: ["order"] }, YOU),
      "has no answer to send",
    );

    await answer("order", ["Before"]);
    await answer("order", ["After"]);
    expect(store.read(thread.id)?.summary.unanswered).toBe(1);
    await store.post(
      thread.id,
      { type: "answer", ask: ask.id, questionId: "why", answer: { picked: [], skipped: true } },
      YOU,
    );
    expect(store.read(thread.id)?.summary.unanswered).toBe(0);
    await store.post(thread.id, { type: "sent", ask: ask.id, questionIds: ["order", "why"] }, YOU);
    await refused(answer("order", ["Before"]), "answered and sent already");
    await refused(
      store.post(thread.id, { type: "sent", ask: ask.id, questionIds: ["order"] }, YOU),
      "sent already",
    );

    const reopened = await open(root);
    expect(reopened.read(thread.id)?.summary.unanswered).toBe(0);
    await refusedIn(reopened, thread.id, ask.id);
  });

  test("refuse a thread that is not there and a question that recommends a choice it lacks", async () => {
    const root = await folder();
    const store = await open(root);
    const missing = await store
      .post(WorkThreadId.parse("nothread1"), { type: "message", text: "hi" }, YOU)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(missing).toBeInstanceOf(WorkThreadRefused);
    const thread = await store.open({ title: "Ask", kind: "task", text: "x", owner: null }, AGENT);
    const bad = await store
      .post(
        thread.id,
        {
          type: "question",
          questions: [
            {
              id: "q",
              question: "Which?",
              options: [{ label: "A" }],
              multi: false,
              recommended: 3,
            },
          ],
        },
        AGENT,
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(bad).toBeInstanceOf(WorkThreadRefused);
    expect(store.read(thread.id)?.summary.entries).toBe(1);
  });

  test("tell listeners each change only once it is in the file", async () => {
    const root = await folder();
    const store = await open(root);
    const heard: Array<{ entries: number; linesOnDisk: number }> = [];
    store.subscribe((summary) => {
      // Read at once, as the listener is told: the entry it hears of is in the file already.
      const onDisk = readFileSync(join(store.folder, `${summary.id}.jsonl`), "utf8");
      heard.push({ entries: summary.entries, linesOnDisk: onDisk.trim().split("\n").length });
    });
    const thread = await store.open(
      { title: "Heard", kind: "task", text: "first", owner: null },
      YOU,
    );
    await store.post(thread.id, { type: "message", text: "second" }, YOU);
    expect(heard).toEqual([
      { entries: 1, linesOnDisk: 1 },
      { entries: 2, linesOnDisk: 2 },
    ]);
  });

  test("show a row's latest words as plain text: Markdown's marks off, its lines joined", async () => {
    const store = await open(await folder());
    const thread = await store.open(
      {
        title: "Memory recall setting",
        kind: "question",
        text: "**Problem:** Hindsight's `recall` took 9–18 s.\n\n- **Open / Closed tabs**, see [the plan](PLAN.md)\n> keep *300*",
        owner: CHAT,
      },
      AGENT,
    );
    expect(store.read(thread.id)?.summary.last?.text).toBe(
      "Problem: Hindsight's recall took 9–18 s. Open / Closed tabs, see the plan keep 300",
    );
    const posted = await store.post(
      thread.id,
      {
        type: "update",
        text: "## Done\n1. `thread_open` and snake_case names stay\n```ts\nx * y * z\n```",
      },
      AGENT,
    );
    expect(posted.summary.last?.text).toBe("Done thread_open and snake_case names stay x * y * z");
  });
});

/** An answer to a sent question is refused after a restart too: what was sent stays sent. */
async function refusedIn(store: WorkThreadStore, id: WorkThreadId, ask: string): Promise<void> {
  const error = await store
    .post(
      id,
      { type: "answer", ask, questionId: "order", answer: { picked: ["Before"], skipped: false } },
      YOU,
    )
    .then(
      () => null,
      (caught: unknown) => caught,
    );
  expect(error).toBeInstanceOf(WorkThreadRefused);
}
