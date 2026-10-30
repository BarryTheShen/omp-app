import type { SessionFilePath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { Inbox, type InboxChat } from "./inbox";

const chat = (id: string, title = id): InboxChat => ({
  threadId: id as ThreadId,
  sessionFile: `/home/me/.omp/sessions/${id}.jsonl` as SessionFilePath,
  title,
});

const rows = (inbox: Inbox): string[] =>
  inbox
    .getSnapshot()
    .map(
      (entry) => `${entry.title}: ${entry.state}${entry.reason === "" ? "" : ` (${entry.reason})`}`,
    );

describe("the attention inbox", () => {
  test("one row per chat: a newer outcome replaces the older; waiting chats first, then the newest", () => {
    const inbox = new Inbox();
    inbox.add(chat("a"), { kind: "done" }, 1);
    inbox.add(chat("b"), { kind: "error", reason: "Invalid API key" }, 2);
    inbox.setWaiting(chat("c"), true, 3);
    inbox.add(chat("a"), { kind: "crashed", reason: "omp exited with code 1" }, 4);
    expect(rows(inbox)).toEqual([
      "c: waiting",
      "a: crashed (omp exited with code 1)",
      "b: error (Invalid API key)",
    ]);
  });

  test("looking at a chat removes what it settled with, but not that it waits for you", () => {
    const inbox = new Inbox();
    inbox.add(chat("a"), { kind: "done" }, 1);
    inbox.setWaiting(chat("b"), true, 2);
    inbox.seen("a" as ThreadId);
    inbox.seen("b" as ThreadId);
    inbox.seen(null);
    expect(rows(inbox)).toEqual(["b: waiting"]);
    inbox.setWaiting(chat("b"), false);
    expect(rows(inbox)).toEqual([]);
  });

  test("Clear removes every settled row and keeps the chats waiting for you", () => {
    const inbox = new Inbox();
    inbox.add(chat("a"), { kind: "done" }, 1);
    inbox.add(chat("b"), { kind: "unstarted", reason: "omp was not found" }, 2);
    inbox.setWaiting(chat("c"), true, 3);
    inbox.clear();
    expect(rows(inbox)).toEqual(["c: waiting"]);
  });

  test("a chat that starts waiting is in a turn again: its earlier outcome goes; its waiting row keeps its time", () => {
    const inbox = new Inbox();
    inbox.add(chat("a"), { kind: "done" }, 1);
    inbox.setWaiting(chat("a"), true, 5);
    expect(rows(inbox)).toEqual(["a: waiting"]);
    // The pane's title arrives later: the row follows it, still from when the chat started waiting.
    inbox.setWaiting(chat("a", "fix the build"), true, 9);
    expect(inbox.getSnapshot()).toMatchObject([
      { title: "fix the build", state: "waiting", at: 5 },
    ]);
  });

  test("a change tells the listeners; one that changes nothing does not", () => {
    const inbox = new Inbox();
    let told = 0;
    const stop = inbox.subscribe(() => {
      told += 1;
    });
    inbox.setWaiting(chat("a"), true, 1);
    inbox.setWaiting(chat("a"), true, 2);
    inbox.setWaiting(chat("b"), false);
    inbox.seen("a" as ThreadId);
    inbox.clear();
    expect(told).toBe(1);
    stop();
    inbox.setWaiting(chat("a"), false);
    expect(told).toBe(1);
  });
});
