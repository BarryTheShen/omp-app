import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ThreadId, type WorkThreadAuthor } from "@omp-app/contracts";
import { nextBriefingAt, writeBriefing } from "./briefing";
import { WorkThreadStore } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CHAT: WorkThreadAuthor = {
  kind: "chat",
  threadId: ThreadId.parse("chat-1"),
  title: "omp-app",
};
const MAIN = ThreadId.parse("chat-main");
/** A moment in the server's own time. */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 10, day, hour, minute).getTime();

describe("the daily briefing", () => {
  test("is written once a day from the threads: what moved, what waits on you, what is in progress", async () => {
    await Bun.write(join(DATA, ".keep"), "");
    const root = await mkdtemp(join(DATA, "briefing-"));
    roots.push(root);
    const clock = { now: at(20, 10) };
    const store = await WorkThreadStore.open(root, { now: () => clock.now });
    await store.setMainChat(MAIN);
    const old = await store.open(
      { title: "Old work", kind: "task", text: "done long ago", owner: null },
      CHAT,
    );
    await store.post(old.id, { type: "state", state: "done" }, CHAT);
    clock.now = at(26, 15);
    const relay = await store.open(
      { title: "Browser relay", kind: "feature", text: "drive the browser", owner: null },
      CHAT,
    );
    await store.post(
      relay.id,
      { type: "update", text: "M3 done", progress: { done: 3, total: 4 } },
      CHAT,
    );
    await store.post(relay.id, { type: "state", state: "in_progress" }, CHAT);
    const voice = await store.open(
      { title: "Voice mode", kind: "feature", text: "plan", owner: null },
      CHAT,
    );
    await store.post(
      voice.id,
      {
        type: "question",
        questions: [{ id: "go", question: "Approve?", options: [], multi: false }],
      },
      CHAT,
    );

    clock.now = at(27, 9);
    const written = await writeBriefing(store, clock.now);
    expect(written?.thread).toMatchObject({
      title: "Daily briefing",
      kind: "briefing",
      owner: MAIN,
    });
    expect(written?.text).toBe(
      [
        "Briefing for Friday, November 27.",
        [
          "**Moved since yesterday**",
          "- **Voice mode** (open, 1 question(s) for you): Approve?",
          "- **Browser relay** (in progress, 3/4): M3 done",
        ].join("\n"),
        ["**Waiting on you**", "- **Voice mode** (open, 1 question(s) for you): Approve?"].join(
          "\n",
        ),
        ["**In progress**", "- **Browser relay** (in progress, 3/4): M3 done"].join("\n"),
      ].join("\n\n"),
    );

    // A restart later the same day writes nothing more; the next morning writes the next entry, in the same thread.
    clock.now = at(27, 18);
    expect(await writeBriefing(store, clock.now)).toBeNull();
    clock.now = at(28, 9, 1);
    const next = await writeBriefing(store, clock.now);
    expect(String(next?.thread.id)).toBe(String(written?.thread.id));
    expect(next?.text).toContain("**Moved since yesterday**\nNothing moved.");
    expect(store.list().filter((thread) => thread.kind === "briefing")).toHaveLength(1);
  });

  test("comes at the next 09:00 of the server's own time", () => {
    expect(nextBriefingAt(at(27, 8, 59))).toBe(at(27, 9));
    expect(nextBriefingAt(at(27, 9))).toBe(at(28, 9));
    expect(nextBriefingAt(at(27, 23))).toBe(at(28, 9));
  });
});
