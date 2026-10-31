import { SessionFilePath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { InboxEntry } from "../inbox/inbox";
import { settledNotices } from "./notify";

const entry = (id: string, state: InboxEntry["state"], at: number, title = id): InboxEntry => ({
  threadId: ThreadId.parse(id),
  sessionFile: SessionFilePath.parse(`/tmp/${id}.jsonl`),
  title,
  state,
  reason: state === "error" ? "the provider refused" : "",
  at,
});

const defaults = { completion: true, error: false };

describe("settledNotices: omp's notifications for turns that end while the window is in the background", () => {
  test("a turn done is 'Complete' while completion.notify is on, and nothing once it is off", () => {
    expect(settledNotices(new Set(), [entry("a", "done", 1)], defaults, false)).toEqual([
      { summary: "a", body: "Complete" },
    ]);
    expect(
      settledNotices(new Set(), [entry("a", "done", 1)], { ...defaults, completion: false }, false),
    ).toEqual([]);
  });

  test("a turn stopped by an error is 'Stopped with error' only while error.notify is on (off by default)", () => {
    expect(settledNotices(new Set(), [entry("a", "error", 1)], defaults, false)).toEqual([]);
    expect(
      settledNotices(new Set(), [entry("a", "error", 1)], { ...defaults, error: true }, false),
    ).toEqual([{ summary: "a", body: "Stopped with error" }]);
  });

  test("nothing while the window has focus, and what was seen then is not raised later", () => {
    const seen = new Set<string>();
    expect(settledNotices(seen, [entry("a", "done", 1)], defaults, true)).toEqual([]);
    expect(settledNotices(seen, [entry("a", "done", 1)], defaults, false)).toEqual([]);
  });

  test("each entry once; the chat's next turn is a new entry", () => {
    const seen = new Set<string>();
    expect(settledNotices(seen, [entry("a", "done", 1)], defaults, false)).toHaveLength(1);
    expect(settledNotices(seen, [entry("a", "done", 1)], defaults, false)).toEqual([]);
    expect(settledNotices(seen, [entry("a", "done", 2)], defaults, false)).toEqual([
      { summary: "a", body: "Complete" },
    ]);
  });

  test("an omp that quit or could not start, and a chat waiting for you, raise nothing here", () => {
    const all = { completion: true, error: true };
    const entries = [
      entry("a", "crashed", 1),
      entry("b", "unstarted", 2),
      entry("c", "waiting", 3),
    ];
    expect(settledNotices(new Set(), entries, all, false)).toEqual([]);
  });

  test("a chat without a title is named omp, as omp names a session without one", () => {
    expect(settledNotices(new Set(), [entry("a", "done", 1, "")], defaults, false)).toEqual([
      { summary: "omp", body: "Complete" },
    ]);
  });
});
