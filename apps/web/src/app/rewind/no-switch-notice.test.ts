import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { NotificationBus, TranscriptNotices } from "@/modules/N1/notifications";
import type { ConversationTransitionPort } from "@/modules/P4/transitions";
import {
  deliverNoteWhenOpen,
  FORK_NO_SWITCH_NOTE,
  type NoSwitchNote,
  type NoteRoute,
  type NoteView,
  REWIND_NO_SWITCH_NOTE,
  showNoSwitchNote,
  withNoSwitchNote,
} from "./no-switch-notice";

/** The transition result fields the note reads; the port stub ignores the request, so it is not built here. */
function resultOf(fields: { readonly cancelled: boolean; readonly reloaded: boolean }) {
  return { ...fields, sourceRetained: true };
}

const request = {} as never;

/** A port stub whose rewind and fork answer with the given outcome; the other methods are recorded. */
function portStub(outcome: {
  readonly branch?: () => Promise<unknown>;
  readonly fork?: () => Promise<unknown>;
}) {
  const stayed = async () => resultOf({ cancelled: false, reloaded: false });
  return {
    branch: vi.fn(outcome.branch ?? stayed),
    fork: vi.fn(outcome.fork ?? stayed),
    getCapabilities: vi.fn(() => ({})),
    updateCapabilities: vi.fn(),
    getRetainedSource: vi.fn(() => null),
    clearRetainedSource: vi.fn(),
  };
}

function wrap(port: object, note = vi.fn<(value: NoSwitchNote) => void>()) {
  return {
    note,
    wrapped: withNoSwitchNote(port as unknown as ConversationTransitionPort, note),
  };
}

describe("withNoSwitchNote", () => {
  test("says so when a rewind finished and the view did not switch", async () => {
    const port = portStub({
      branch: async () => resultOf({ cancelled: false, reloaded: false }),
    });
    const { note, wrapped } = wrap(port);

    await wrapped.branch(request);

    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(REWIND_NO_SWITCH_NOTE);
  });

  test("stays silent when the view switched to the rewound chat", async () => {
    const port = portStub({ branch: async () => resultOf({ cancelled: false, reloaded: true }) });
    const { note, wrapped } = wrap(port);

    await expect(wrapped.branch(request)).resolves.toMatchObject({ reloaded: true });

    expect(note).not.toHaveBeenCalled();
  });

  test("stays silent when the rewind was cancelled before it changed anything", async () => {
    const port = portStub({ branch: async () => resultOf({ cancelled: true, reloaded: false }) });
    const { note, wrapped } = wrap(port);

    await expect(wrapped.branch(request)).resolves.toMatchObject({ cancelled: true });

    expect(note).not.toHaveBeenCalled();
  });

  test("a failed rewind says nothing here, and its failure reaches the caller", async () => {
    const failure = new Error("omp refused the rewind");
    const port = portStub({ branch: () => Promise.reject(failure) });
    const { note, wrapped } = wrap(port);

    await expect(wrapped.branch(request)).rejects.toBe(failure);

    expect(note).not.toHaveBeenCalled();
  });

  test("says so when a fork finished and the view did not switch", async () => {
    const port = portStub({ fork: async () => resultOf({ cancelled: false, reloaded: false }) });
    const { note, wrapped } = wrap(port);

    await wrapped.fork(request);

    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(FORK_NO_SWITCH_NOTE);
  });

  test("a fork that switched the view says nothing", async () => {
    const port = portStub({ fork: async () => resultOf({ cancelled: false, reloaded: true }) });
    const { note, wrapped } = wrap(port);

    await wrapped.fork(request);

    expect(note).not.toHaveBeenCalled();
  });

  test("passes the rest of the port through to the port itself", () => {
    const port = portStub({});
    const { wrapped } = wrap(port);

    expect(wrapped.getCapabilities()).toEqual({});
    wrapped.updateCapabilities({});
    expect(port.updateCapabilities).toHaveBeenCalledWith({});
    expect(wrapped.getRetainedSource()).toBeNull();
    wrapped.clearRetainedSource();
    expect(port.clearRetainedSource).toHaveBeenCalledTimes(1);
  });

  test("the notes say what happened in plain words, and that the chat the person picked stays open", () => {
    for (const value of [REWIND_NO_SWITCH_NOTE, FORK_NO_SWITCH_NOTE]) {
      expect(value.message).toMatch(
        /^The (rewind|fork) finished\. The chat you picked stays open\.$/,
      );
      expect(value.message).not.toMatch(/omp|thread|session|\bid\b/i);
    }
  });
});

describe("showNoSwitchNote", () => {
  test("writes the note into the chat it names, in the bus and the transcript, and leaves it unread aloud", () => {
    const bus = new NotificationBus();
    const transcript = new TranscriptNotices();
    const chat = ThreadId.parse("thread-picked-last");

    showNoSwitchNote(
      { getBus: () => bus, getTranscript: () => transcript },
      chat,
      REWIND_NO_SWITCH_NOTE,
    );

    expect(transcript.getSnapshot().notices).toMatchObject([
      {
        threadId: chat,
        dedupeKey: "rewind:no-switch",
        placement: "transcript",
        severity: "info",
        message: REWIND_NO_SWITCH_NOTE.message,
        live: "off",
      },
    ]);
    expect(bus.get(chat, "rewind:no-switch")).toMatchObject({
      message: REWIND_NO_SWITCH_NOTE.message,
    });
  });
});

describe("deliverNoteWhenOpen", () => {
  /**
   * A route the test drives. `register` puts a view on screen and wakes a note that waits for one; `waiting` resolves
   * once a note is waiting for a view.
   */
  function routeStub(start: { readonly open?: ThreadId; readonly view?: NoteView | null }) {
    const open = start.open;
    let view = start.view ?? null;
    const wakers: Array<() => void> = [];
    let announce = (): void => undefined;
    const waiting = new Promise<void>((resolve) => {
      announce = () => resolve();
    });
    const route: NoteRoute = {
      whenSettled: () => Promise.resolve(),
      openThreadId: () => open,
      view: () => view,
      nextView: () => {
        announce();
        return new Promise<void>((wake) => {
          wakers.push(wake);
        });
      },
    };
    return {
      route,
      waiting,
      register(next: NoteView) {
        view = next;
        for (const wake of wakers.splice(0)) wake();
      },
    };
  }

  test("writes the note through the view of the chat open when it is delivered", async () => {
    const chat = ThreadId.parse("thread-open-now");
    const notice = vi.fn<(value: NoSwitchNote) => void>();
    const stub = routeStub({ open: chat, view: { threadId: chat, notice } });

    await deliverNoteWhenOpen(stub.route, REWIND_NO_SWITCH_NOTE);

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(REWIND_NO_SWITCH_NOTE);
  });

  test("waits for the open chat's view to come on screen, then writes the note there", async () => {
    const chat = ThreadId.parse("thread-still-opening");
    const notice = vi.fn<(value: NoSwitchNote) => void>();
    const stub = routeStub({ open: chat, view: null });

    const delivered = deliverNoteWhenOpen(stub.route, REWIND_NO_SWITCH_NOTE);
    await stub.waiting;
    expect(notice).not.toHaveBeenCalled();

    stub.register({ threadId: chat, notice });
    await delivered;

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(REWIND_NO_SWITCH_NOTE);
  });

  test("never writes through another chat's view: it waits for the open chat's own view", async () => {
    const picked = ThreadId.parse("thread-picked-last");
    const earlier = ThreadId.parse("thread-rewound-from");
    const pickedNotice = vi.fn<(value: NoSwitchNote) => void>();
    const earlierNotice = vi.fn<(value: NoSwitchNote) => void>();
    const stub = routeStub({ open: picked, view: { threadId: earlier, notice: earlierNotice } });

    const delivered = deliverNoteWhenOpen(stub.route, REWIND_NO_SWITCH_NOTE);
    await stub.waiting;
    expect(earlierNotice).not.toHaveBeenCalled();

    stub.register({ threadId: picked, notice: pickedNotice });
    await delivered;

    expect(earlierNotice).not.toHaveBeenCalled();
    expect(pickedNotice).toHaveBeenCalledWith(REWIND_NO_SWITCH_NOTE);
  });

  test("writes nothing when no chat is open, and waits for no view", async () => {
    const chat = ThreadId.parse("thread-after-new-chat");
    const notice = vi.fn<(value: NoSwitchNote) => void>();
    const stub = routeStub({ view: { threadId: chat, notice } });

    await deliverNoteWhenOpen(stub.route, REWIND_NO_SWITCH_NOTE);

    expect(notice).not.toHaveBeenCalled();
  });
});
