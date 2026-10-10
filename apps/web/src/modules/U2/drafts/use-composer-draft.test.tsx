import { type DraftScope, ThreadId } from "@omp-app/contracts";
import { act, cleanup, render } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { DraftController, type DraftTimer } from "./drafts";
import { ScopedDraftStore } from "./test-support";
import { useComposerDraft } from "./use-composer-draft";

afterEach(cleanup);

// Autosave never fires here: every write happens at a step the test takes.
const noTimers: DraftTimer = { setTimeout: () => undefined, clearTimeout: () => undefined };

function chatScope(id: string): DraftScope {
  return { kind: "thread", threadId: ThreadId.parse(id) };
}

/** A store whose reads wait while the store is held, so a chat's draft is still loading while the test types. */
class HeldReadStore extends ScopedDraftStore {
  private gate = Promise.withResolvers<void>();
  private holding = false;

  hold(): void {
    this.gate = Promise.withResolvers<void>();
    this.holding = true;
  }

  release(): void {
    this.holding = false;
    this.gate.resolve();
  }

  override async get(args: Parameters<ScopedDraftStore["get"]>[0]) {
    if (this.holding) await this.gate.promise;
    return super.get(args);
  }
}

const noAttachments = {
  restore: async () => undefined,
  toDraftRefs: () => [],
};
const notRecalled = () => false;

/** What the composer shows. The test types by setting it, as the person's keystrokes do. */
interface ShownComposer {
  text: string;
  type(text: string): void;
}

function Composer({
  controller,
  shown,
}: {
  readonly controller: DraftController;
  readonly shown: ShownComposer;
}) {
  const [text, setText] = useState("");
  const composer = useMemo(() => ({ setText }), []);
  shown.text = text;
  shown.type = setText;
  useComposerDraft({
    controller,
    text,
    composer,
    attachments: noAttachments,
    isRecalledPrompt: notRecalled,
  });
  return null;
}

/** Renders the composer that stays mounted across chats, as the app does, and switches the chat it binds to. */
function renderComposer(controller: DraftController) {
  const shown: ShownComposer = { text: "", type: () => undefined };
  const view = render(<Composer controller={controller} shown={shown} />);
  return {
    shown,
    switchTo: (next: DraftController) =>
      view.rerender(<Composer controller={next} shown={shown} />),
  };
}

describe("useComposerDraft: text typed before the chat's draft loads", () => {
  test("is still in the composer once the draft has loaded", async () => {
    const store = new HeldReadStore();
    store.hold();
    const chat = new DraftController({ store, scope: chatScope("chat-a"), timers: noTimers });
    const { shown } = renderComposer(chat);
    let loading: Promise<unknown> = Promise.resolve();
    act(() => {
      loading = chat.load();
    });
    act(() => shown.type("typed before load"));

    await act(async () => {
      store.release();
      await loading;
    });

    expect(shown.text).toBe("typed before load");
  });

  test("is kept when a saved draft arrives after it, and the saved draft does not replace it", async () => {
    const store = new HeldReadStore();
    await store.save({
      scope: chatScope("chat-b"),
      draft: { text: "saved draft", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    store.hold();
    const chat = new DraftController({ store, scope: chatScope("chat-b"), timers: noTimers });
    const { shown } = renderComposer(chat);
    let loading: Promise<unknown> = Promise.resolve();
    act(() => {
      loading = chat.load();
    });
    act(() => shown.type("typed first"));

    await act(async () => {
      store.release();
      await loading;
    });

    expect(shown.text).toBe("typed first");
  });

  test("is saved to that chat, not lost", async () => {
    const store = new HeldReadStore();
    store.hold();
    const chat = new DraftController({ store, scope: chatScope("chat-f"), timers: noTimers });
    const { shown } = renderComposer(chat);
    let loading: Promise<unknown> = Promise.resolve();
    act(() => {
      loading = chat.load();
    });
    act(() => shown.type("typed before load"));

    await act(async () => {
      store.release();
      await loading;
      await chat.flush();
    });

    expect(store.text(chatScope("chat-f"))).toBe("typed before load");
  });

  test("a saved draft shows in the composer when the chat loads, with nothing typed", async () => {
    const store = new HeldReadStore();
    await store.save({
      scope: chatScope("chat-c"),
      draft: { text: "saved draft", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    store.hold();
    const chat = new DraftController({ store, scope: chatScope("chat-c"), timers: noTimers });
    const { shown } = renderComposer(chat);
    let loading: Promise<unknown> = Promise.resolve();
    act(() => {
      loading = chat.load();
    });

    await act(async () => {
      store.release();
      await loading;
    });

    expect(shown.text).toBe("saved draft");
  });

  test("text typed and then deleted before the draft loads stays deleted once it has loaded", async () => {
    const store = new HeldReadStore();
    await store.save({
      scope: chatScope("chat-g"),
      draft: { text: "saved draft", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    store.hold();
    const chat = new DraftController({ store, scope: chatScope("chat-g"), timers: noTimers });
    const { shown } = renderComposer(chat);
    let loading: Promise<unknown> = Promise.resolve();
    act(() => {
      loading = chat.load();
    });
    act(() => shown.type("typed then deleted"));
    act(() => shown.type(""));

    await act(async () => {
      store.release();
      await loading;
    });

    expect(shown.text).toBe("");
  });
});

describe("useComposerDraft: switching chats", () => {
  test("text still on screen from the previous chat is not saved into the next chat", async () => {
    const store = new ScopedDraftStore();
    const first = new DraftController({ store, scope: chatScope("chat-d1"), timers: noTimers });
    const { shown, switchTo } = renderComposer(first);
    await act(async () => {
      await first.load();
    });
    act(() => shown.type("old chat text"));

    const second = new DraftController({ store, scope: chatScope("chat-d2"), timers: noTimers });
    switchTo(second);
    await act(async () => {
      await second.load();
      await second.flush();
    });

    expect(shown.text).toBe("");
    expect(store.text(chatScope("chat-d2"))).toBeUndefined();
  });

  test("an empty composer while the next chat's draft loads does not blank that chat's saved draft", async () => {
    const store = new HeldReadStore();
    await store.save({
      scope: chatScope("chat-e2"),
      draft: { text: "saved draft", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const first = new DraftController({ store, scope: chatScope("chat-e1"), timers: noTimers });
    const { shown, switchTo } = renderComposer(first);
    await act(async () => {
      await first.load();
    });
    store.hold();
    const second = new DraftController({ store, scope: chatScope("chat-e2"), timers: noTimers });
    switchTo(second);
    let loading: Promise<unknown> = Promise.resolve();
    act(() => {
      loading = second.load();
    });

    await act(async () => {
      store.release();
      await loading;
      await second.flush();
    });

    expect(shown.text).toBe("saved draft");
    expect(store.text(chatScope("chat-e2"))).toBe("saved draft");
  });
});

describe("useComposerDraft: the controller's text changed without the composer", () => {
  test("a remote choice puts the other tab's text in the composer, and the next keystroke saves on top of it", async () => {
    const store = new ScopedDraftStore();
    const scope = chatScope("chat-h");
    await store.save({
      scope,
      draft: { text: "base", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = new DraftController({ store, scope, timers: noTimers });
    const { shown } = renderComposer(chat);
    await act(async () => {
      await chat.load();
    });
    // Another tab saves a different draft while this tab's text is unsaved: this tab's save conflicts.
    await store.save({
      scope,
      draft: { text: "other tab text", attachments: [], failedSends: [] },
      expectedRevision: chat.getSnapshot().revision,
    });
    act(() => shown.type("local text"));
    await act(async () => {
      await chat.flush();
    });
    expect(chat.getSnapshot().status).toBe("conflict");

    await act(async () => {
      await chat.resolveConflict("remote");
    });
    expect(shown.text).toBe("other tab text");
    expect(chat.getSnapshot().dirty).toBe(false);

    act(() => shown.type("other tab text!"));
    await act(async () => {
      await chat.flush();
    });
    expect(store.text(scope)).toBe("other tab text!");
  });

  test("a draft another tab saves, with no unsaved edit here, is shown in the composer", async () => {
    const store = new ScopedDraftStore();
    const scope = chatScope("chat-i");
    await store.save({
      scope,
      draft: { text: "first", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = new DraftController({ store, scope, timers: noTimers });
    const { shown } = renderComposer(chat);
    await act(async () => {
      await chat.load();
    });
    expect(shown.text).toBe("first");

    await store.save({
      scope,
      draft: { text: "from another tab", attachments: [], failedSends: [] },
      expectedRevision: chat.getSnapshot().revision,
    });
    // The controller reads the stored draft again, as it does when the store reports a change.
    await act(async () => {
      await chat.load();
    });

    expect(shown.text).toBe("from another tab");
    expect(chat.getSnapshot().dirty).toBe(false);
  });

  test("text typed for a chat before its draft loads is saved, even when it equals the previous chat's text", async () => {
    const store = new ScopedDraftStore();
    const first = new DraftController({ store, scope: chatScope("chat-j1"), timers: noTimers });
    const { shown, switchTo } = renderComposer(first);
    await act(async () => {
      await first.load();
    });
    act(() => shown.type("same text"));

    const second = new DraftController({ store, scope: chatScope("chat-j2"), timers: noTimers });
    switchTo(second);
    act(() => shown.type("same text"));
    await act(async () => {
      await second.load();
      await second.flush();
    });

    expect(store.text(chatScope("chat-j2"))).toBe("same text");
  });
});
