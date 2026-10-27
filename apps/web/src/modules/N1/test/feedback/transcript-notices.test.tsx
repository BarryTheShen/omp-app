import type { ChatSessionEvent } from "@omp-app/contracts";
import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import { TranscriptNoticeList, transcriptNoticeSource } from "../../feedback";
import { NotificationProjector } from "../../notifications";

const threadId = ThreadIdSchema.parse("thread-n1-transcript-list");

afterEach(() => {
  cleanup();
});

/** One chat as the app wires it: the projector writes its transcript notices into the list the chat draws. */
function chat() {
  const store = new OmpRuntimeStore({ threadId });
  const projector = new NotificationProjector({ source: store, events: store });
  return { store, projector };
}

function omp(store: OmpRuntimeStore, event: Record<string, unknown>, sequence: number): void {
  store.ingest({ kind: "event", event } as unknown as ChatSessionEvent, sequence);
}

describe("TranscriptNoticeList", () => {
  test("a todo reminder shows its heading with the attempt, and each unfinished item", () => {
    const { store, projector } = chat();
    omp(
      store,
      {
        type: "todo_reminder",
        todos: [
          { content: "Write the thing", status: "pending" },
          { content: "Test the thing", status: "in_progress" },
        ],
        attempt: 1,
        maxAttempts: 3,
      },
      1,
    );

    const { container } = render(
      <TranscriptNoticeList projector={projector} threadId={threadId} />,
    );
    const card = container.querySelector<HTMLElement>('[data-dedupe-key^="todo-reminder:"]');
    expect(card?.dataset.severity).toBe("warning");
    expect(card?.querySelector("p")?.textContent).toBe("Unfinished todos (attempt 1 of 3)");
    expect(card?.textContent).toContain("• Write the thing\n• Test the thing");
    projector.dispose();
  });

  test("a failed retry shows its final notice as an error, in omp's words", () => {
    const { store, projector } = chat();
    omp(
      store,
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "provider down" },
      1,
    );

    const { container } = render(
      <TranscriptNoticeList projector={projector} threadId={threadId} />,
    );
    const card = container.querySelector<HTMLElement>('[data-dedupe-key="retry:result"]');
    expect(card?.dataset.severity).toBe("error");
    expect(card?.textContent).toBe("Retry failed after 3 attempts: provider down");
    projector.dispose();
  });

  test("a later reminder replaces the one before it, so only the latest attempt is drawn", () => {
    const { store, projector } = chat();
    omp(
      store,
      {
        type: "todo_reminder",
        todos: [{ content: "Write the thing", status: "pending" }],
        attempt: 1,
        maxAttempts: 3,
      },
      1,
    );
    omp(
      store,
      {
        type: "todo_reminder",
        todos: [{ content: "Write the thing", status: "pending" }],
        attempt: 2,
        maxAttempts: 3,
      },
      2,
    );

    const { container } = render(
      <TranscriptNoticeList projector={projector} threadId={threadId} />,
    );
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.textContent).toContain("Unfinished todos (attempt 2 of 3)");
    expect(container.textContent).not.toContain("attempt 1 of 3");
    projector.dispose();
  });

  test("draws only the notices of its own chat", () => {
    const other = ThreadIdSchema.parse("thread-n1-transcript-list-other");
    const { projector } = chat();
    projector.getTranscript().upsert({
      threadId: other,
      dedupeKey: "retry:result",
      severity: "error",
      placement: "transcript",
      message: "Another chat's failure",
      source: "omp.retry",
      live: "assertive",
      focus: "preserve",
    });

    const { container } = render(
      <TranscriptNoticeList projector={projector} threadId={threadId} />,
    );
    expect(container.innerHTML).toBe("");
    expect(container.textContent).not.toContain("Another chat's failure");
    projector.dispose();
  });
});

describe("transcriptNoticeSource", () => {
  const reminder = {
    severity: "warning" as const,
    placement: "transcript" as const,
    message: "Unfinished todos (attempt 1 of 3)\n• Write the thing",
    source: "omp.todo",
    live: "polite" as const,
    focus: "preserve" as const,
  };

  test("lists this chat's notices with the row each follows, and draws a group by its keys", () => {
    const { projector } = chat();
    const other = ThreadIdSchema.parse("thread-n1-transcript-other");
    const transcript = projector.getTranscript();
    transcript.upsert({
      ...reminder,
      threadId,
      dedupeKey: "todo-reminder:1:aaaaaa",
      afterMessage: "stream:thread-n1-transcript-list:0:m1",
    });
    transcript.upsert({
      ...reminder,
      threadId: other,
      dedupeKey: "todo-reminder:1:bbbbbb",
      afterMessage: "stream:thread-n1-transcript-list:0:m2",
    });

    const source = transcriptNoticeSource(projector, threadId);
    expect(source.getSnapshot()).toEqual([
      { key: "todo-reminder:1:aaaaaa", afterRow: "stream:thread-n1-transcript-list:0:m1" },
    ]);
    const { container } = render(source.renderGroup(["todo-reminder:1:aaaaaa"]));
    expect(
      container.querySelector('[data-dedupe-key="todo-reminder:1:aaaaaa"]')?.textContent,
    ).toContain("Unfinished todos (attempt 1 of 3)");
    expect(container.querySelector('[data-dedupe-key="todo-reminder:1:bbbbbb"]')).toBeNull();
  });

  test("the list is the same array until the transcript changes", () => {
    const { projector } = chat();
    const source = transcriptNoticeSource(projector, threadId);
    const first = source.getSnapshot();
    expect(source.getSnapshot()).toBe(first);
    projector
      .getTranscript()
      .upsert({ ...reminder, threadId, dedupeKey: "todo-reminder:1:cccccc" });
    expect(source.getSnapshot()).not.toBe(first);
  });
});
