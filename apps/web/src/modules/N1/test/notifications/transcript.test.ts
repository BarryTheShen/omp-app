import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { Notification } from "../../contract";
import { TranscriptNotices } from "../../notifications";

const threadId = ThreadIdSchema.parse("thread-n1-transcript");

function notice(
  dedupeKey: string,
  message: string,
  source: string,
  owner = threadId,
): Notification {
  return {
    threadId: owner,
    dedupeKey,
    severity: "warning",
    placement: "transcript",
    message,
    source,
    live: "polite",
    focus: "preserve",
  };
}

describe("TranscriptNotices", () => {
  test("a notice written to the transcript is listed, and a notice of another kind is kept beside it", () => {
    const transcript = new TranscriptNotices();
    transcript.upsert(notice("todo-reminder:1", "todos", "omp.todo"));
    transcript.upsert(notice("retry:result", "Retry failed", "omp.retry"));

    expect(transcript.getSnapshot().notices.map((item) => item.dedupeKey)).toEqual([
      "todo-reminder:1",
      "retry:result",
    ]);
  });

  test("a newer notice of the same kind replaces the older one, so the list keeps the latest", () => {
    const transcript = new TranscriptNotices();
    transcript.upsert(notice("todo-reminder:1", "attempt 1", "omp.todo"));
    transcript.upsert(notice("retry:result", "Retry failed", "omp.retry"));
    transcript.upsert(notice("todo-reminder:2", "attempt 2", "omp.todo"));

    expect(transcript.getSnapshot().notices.map((item) => item.message)).toEqual([
      "Retry failed",
      "attempt 2",
    ]);
  });

  test("the same kind in another chat is a different notice", () => {
    const other = ThreadIdSchema.parse("thread-n1-transcript-other");
    const transcript = new TranscriptNotices();
    transcript.upsert(notice("todo-reminder:1", "this chat", "omp.todo"));
    transcript.upsert(notice("todo-reminder:1", "other chat", "omp.todo", other));

    expect(transcript.getSnapshot().notices.map((item) => item.message)).toEqual([
      "this chat",
      "other chat",
    ]);
  });

  test("tells subscribers about each change until they unsubscribe", () => {
    const transcript = new TranscriptNotices();
    let changes = 0;
    const unsubscribe = transcript.subscribe(() => {
      changes += 1;
    });
    transcript.upsert(notice("todo-reminder:1", "attempt 1", "omp.todo"));
    transcript.upsert(notice("todo-reminder:2", "attempt 2", "omp.todo"));
    expect(changes).toBe(2);

    unsubscribe();
    transcript.upsert(notice("retry:result", "Retry failed", "omp.retry"));
    expect(changes).toBe(2);
  });

  test("a notice keeps the row it follows, and a later notice of its kind carries the row that one follows", () => {
    const transcript = new TranscriptNotices();
    transcript.upsert({
      ...notice("todo-reminder:1", "attempt 1", "omp.todo"),
      afterMessage: "row-1",
    });
    expect(transcript.getSnapshot().notices[0]?.afterMessage).toBe("row-1");
    transcript.upsert({
      ...notice("todo-reminder:2", "attempt 2", "omp.todo"),
      afterMessage: "row-2",
    });
    expect(transcript.getSnapshot().notices.map((item) => item.afterMessage)).toEqual(["row-2"]);
  });
});
