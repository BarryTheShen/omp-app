import {
  AppFailure,
  type AttachmentRef,
  type DraftScope,
  FolderPath,
  ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { type AttachmentBlobStore, AttachmentManager, type StoredAttachment } from "../attachments";
import { DraftController, type DraftTimer } from "./drafts";
import { ScopedDraftStore, useComposerText } from "./test-support";
import {
  type ComposerSendHold,
  composerDraftForLifecycle,
  useComposerDraft,
} from "./use-composer-draft";

afterEach(cleanup);

// Autosave never fires here: every write happens at a step the test takes.
const noTimers: DraftTimer = { setTimeout: () => undefined, clearTimeout: () => undefined };

function chatScope(id: string): DraftScope {
  return { kind: "thread", threadId: ThreadId.parse(id) };
}

/** A store whose reads wait while the store is held, so a chat's draft is still loading while the test types. */
class HeldReadStore extends ScopedDraftStore {
  private gate = Promise.withResolvers<void>();
  private readStarted = Promise.withResolvers<void>();
  private holding = false;

  hold(): void {
    this.gate = Promise.withResolvers<void>();
    this.readStarted = Promise.withResolvers<void>();
    this.holding = true;
  }

  async waitUntilReadStarts(): Promise<void> {
    await this.readStarted.promise;
  }

  release(): void {
    this.holding = false;
    this.gate.resolve();
  }

  override async get(args: Parameters<ScopedDraftStore["get"]>[0]) {
    if (this.holding) {
      this.readStarted.resolve();
      await this.gate.promise;
    }
    return super.get(args);
  }
}

const NO_ATTACHMENTS = { pending: [], complete: [], error: null };
const noAttachments = {
  restore: async () => undefined,
  dropPending: () => undefined,
  toDraftRefs: () => [],
  holdForSend: () => undefined,
  takeHeldForSend: () => null,
  getState: () => NO_ATTACHMENTS,
  subscribe: () => () => undefined,
};
const notRecalled = () => false;

/** What the composer shows. The test types by setting it, as the person's keystrokes do. */
interface ShownComposer {
  text: string;
  type(text: string): void;
}

/** The attachments a composer binds to: the app's attachment manager, or a stand-in. */
type ComposerAttachments = Parameters<typeof useComposerDraft>[0]["attachments"];

function Composer({
  chat,
  controller,
  shown,
  attachments,
  switching = false,
  isRecalledPrompt = notRecalled,
}: {
  readonly chat: object;
  readonly controller: DraftController;
  readonly shown: ShownComposer;
  readonly attachments: ComposerAttachments;
  readonly switching?: boolean;
  readonly isRecalledPrompt?: (text: string) => boolean;
}) {
  const { text, composer } = useComposerText();
  shown.text = text;
  shown.type = composer.setText;
  useComposerDraft({
    chat,
    controller,
    switching,
    text,
    composer,
    attachments,
    isRecalledPrompt,
  });
  return null;
}

/**
 * Renders the composer as the app shows it, bound to a chat. Another chat is another `chat` identity, and its draft is
 * built again; a move of the same chat's draft keeps the identity and changes only the controller.
 */
function renderComposer(
  controller: DraftController,
  attachments: ComposerAttachments = noAttachments,
  isRecalledPrompt: (text: string) => boolean = notRecalled,
) {
  const shown: ShownComposer = { text: "", type: () => undefined };
  const chat = {};
  const view = render(
    <Composer
      attachments={attachments}
      chat={chat}
      controller={controller}
      isRecalledPrompt={isRecalledPrompt}
      shown={shown}
    />,
  );
  return {
    shown,
    chat,
    /** Shows another draft: another chat by default, or the same chat (`chat`) with a moved draft. */
    switchTo: (next: DraftController, nextChat: object = {}, switching = false) =>
      view.rerender(
        <Composer
          attachments={attachments}
          chat={nextChat}
          controller={next}
          isRecalledPrompt={isRecalledPrompt}
          shown={shown}
          switching={switching}
        />,
      ),
    unmount: () => view.unmount(),
  };
}

/**
 * Blobs in memory, as the app's blob store keeps them: a stored attachment is found again by its ref. The server names a
 * blob by its own id (`serverIdPrefix` stands for that), not by the id the composer gave the file.
 */
class MemoryBlobStore implements AttachmentBlobStore {
  private readonly values = new Map<string, StoredAttachment>();
  private readonly serverIdPrefix: string;

  constructor(serverIdPrefix = "") {
    this.serverIdPrefix = serverIdPrefix;
  }

  async put(input: { readonly id: string; readonly file: File }): Promise<StoredAttachment> {
    const id = `${this.serverIdPrefix}${input.id}`;
    const uri = `attachment://${id}`;
    const ref: AttachmentRef = {
      id,
      name: input.file.name,
      mediaType: input.file.type,
      sizeBytes: input.file.size,
      uri,
    };
    const stored: StoredAttachment = { ref, content: [{ type: "image", image: uri }] };
    this.values.set(id, stored);
    return stored;
  }

  async get(ref: AttachmentRef): Promise<StoredAttachment> {
    const stored = this.values.get(ref.id);
    if (stored === undefined) throw new Error("missing blob");
    return stored;
  }

  async delete(ref: AttachmentRef): Promise<void> {
    this.values.delete(ref.id);
  }
}

/** Blobs that cannot be read back: what a restore meets when the connection drops during a send. */
class UnreachableBlobStore extends MemoryBlobStore {
  override async get(): Promise<StoredAttachment> {
    throw new Error("connection closed");
  }
}

/** Blobs in memory, except the ones lost: a lost blob cannot be read back, as when the server no longer has it. */
class FlakyBlobStore extends MemoryBlobStore {
  private readonly lost = new Set<string>();

  lose(name: string): void {
    this.lost.add(name);
  }

  override async get(ref: AttachmentRef): Promise<StoredAttachment> {
    if (this.lost.has(ref.name)) throw new Error("missing blob");
    return super.get(ref);
  }
}

/** A drop of one image file: the composer adds it and sends it, as the app does. Returns the chip as the composer named it. */
async function drop(manager: AttachmentManager, name: string) {
  const pending = await manager.add({ file: new File(["png bytes"], name, { type: "image/png" }) });
  await manager.send(pending);
  return pending;
}

test("pagehide while a recalled prompt is shown keeps the typed draft and its attachments", async () => {
  const store = new ScopedDraftStore();
  const scope = chatScope("recalled-pagehide");
  const controller = new DraftController({
    store,
    scope,
    timers: noTimers,
    lifecycle: window,
  });
  const ref: AttachmentRef = {
    id: "draft-blob",
    name: "draft.png",
    mediaType: "image/png",
    uri: "attachment://draft-blob",
  };
  await controller.load();
  controller.setDraft("my draft", [ref]);
  controller.setLifecycleReader({
    read: () =>
      composerDraftForLifecycle(controller, "hello probe", [], (text) => text === "hello probe"),
  });

  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
    await controller.flush();
  });

  expect((await store.get({ scope })).draft).toMatchObject({
    text: "my draft",
    attachments: [ref],
  });
  await controller.dispose();
});

test.each([true, false])(
  "keeps a recalled prompt when the same chat draft moves (destination loaded first: %s)",
  async (loadDestinationFirst) => {
    const store = new HeldReadStore();
    const folder = FolderPath.parse("/workspace/app");
    const folderScope: DraftScope = { kind: "folder", folder };
    await store.save({
      scope: folderScope,
      draft: { text: "my draft", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const first = new DraftController({ store, scope: folderScope, timers: noTimers });
    await first.load();
    const recalled = (text: string): boolean => text === "hello probe";
    const view = renderComposer(first, noAttachments, recalled);
    await waitFor(() => expect(view.shown.text).toBe("my draft"));
    act(() => view.shown.type("hello probe"));
    const next = new DraftController({
      store,
      scope: chatScope("recalled-move"),
      timers: noTimers,
    });

    if (loadDestinationFirst) await next.load();
    else store.hold();
    view.switchTo(next, view.chat, true);

    if (!loadDestinationFirst) {
      let loading: Promise<unknown> = Promise.resolve();
      act(() => {
        loading = next.load();
      });
      await store.waitUntilReadStarts();
      expect(view.shown.text).toBe("hello probe");
      store.release();
      await act(async () => loading);
    }

    expect(view.shown.text).toBe("hello probe");
    expect(store.text(chatScope("recalled-move"))).toBeUndefined();
    view.unmount();
    await first.dispose();
    await next.dispose();
  },
);
test("clear and restore ordering is owned by the draft hook", async () => {
  const store = new ScopedDraftStore();
  const scope = chatScope("switch-order");
  const controller = new DraftController({ store, scope, timers: noTimers });
  await store.save({
    scope,
    draft: { text: "saved draft", attachments: [], failedSends: [] },
    expectedRevision: null,
  });
  const shown: ShownComposer = { text: "", type: () => undefined };
  const chat = {};
  const view = render(
    <Composer
      attachments={noAttachments}
      chat={chat}
      controller={controller}
      shown={shown}
      switching={false}
    />,
  );
  await act(async () => {
    await controller.load();
  });
  expect(shown.text).toBe("saved draft");

  view.rerender(
    <Composer
      attachments={noAttachments}
      chat={chat}
      controller={controller}
      shown={shown}
      switching
    />,
  );
  await waitFor(() => expect(shown.text).toBe("saved draft"));

  view.rerender(
    <Composer
      attachments={noAttachments}
      chat={chat}
      controller={controller}
      shown={shown}
      switching={false}
    />,
  );
  act(() => controller.setDraft("restore before clear", []));
  await waitFor(() => expect(shown.text).toBe("restore before clear"));
  view.rerender(
    <Composer
      attachments={noAttachments}
      chat={chat}
      controller={controller}
      shown={shown}
      switching
    />,
  );
  await waitFor(() => expect(shown.text).toBe("restore before clear"));
  view.unmount();
});
test("a switching signal does not clear text typed after the controller value", async () => {
  const store = new ScopedDraftStore();
  const controller = new DraftController({
    store,
    scope: chatScope("switch-guard"),
    timers: noTimers,
  });
  const { shown, switchTo } = renderComposer(controller);
  await act(async () => controller.load());
  act(() => shown.type("newer typed text"));
  switchTo(controller, {}, true);
  expect(shown.text).toBe("newer typed text");
});
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

describe("useComposerDraft: attachments", () => {
  test("an attachment dropped without text is saved when its chat is left, and comes back when the chat is opened again", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const first = new DraftController({ store, scope: chatScope("chat-l1"), timers: noTimers });
    const { switchTo } = renderComposer(first, manager);
    await act(async () => {
      await first.load();
      await drop(manager, "photo.png");
    });

    // Leaving the chat disposes its controller, which saves what that controller holds.
    const second = new DraftController({ store, scope: chatScope("chat-l2"), timers: noTimers });
    await act(async () => {
      await first.dispose();
      switchTo(second);
      await second.load();
    });

    const back = new DraftController({ store, scope: chatScope("chat-l1"), timers: noTimers });
    await act(async () => {
      await second.dispose();
      switchTo(back);
      await back.load();
    });

    await waitFor(() => {
      expect(manager.toDraftRefs().map((ref) => ref.name)).toEqual(["photo.png"]);
    });
    const saved = await store.get({ scope: chatScope("chat-l1") });
    expect(saved.draft?.text).toBe("");
    expect(saved.draft?.attachments.map((ref) => ref.name)).toEqual(["photo.png"]);
  });

  test("the previous chat's attachment is not in the next chat, nor saved into it by text typed before it loads", async () => {
    const store = new HeldReadStore();
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const first = new DraftController({ store, scope: chatScope("chat-m1"), timers: noTimers });
    const { shown, switchTo } = renderComposer(first, manager);
    await act(async () => {
      await first.load();
      await drop(manager, "photo.png");
    });

    store.hold();
    const second = new DraftController({ store, scope: chatScope("chat-m2"), timers: noTimers });
    let loading: Promise<unknown> = Promise.resolve();
    await act(async () => {
      await first.dispose();
      switchTo(second);
      loading = second.load();
    });
    expect(manager.toDraftRefs()).toEqual([]);

    act(() => shown.type("typed before load"));
    await act(async () => {
      store.release();
      await loading;
      await second.flush();
    });
    expect(store.text(chatScope("chat-m2"))).toBe("typed before load");
    expect((await store.get({ scope: chatScope("chat-m2") })).draft?.attachments).toEqual([]);
  });

  test("an attachment removed from the chat is removed from the draft saved for it", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const chat = new DraftController({ store, scope: chatScope("chat-n"), timers: noTimers });
    renderComposer(chat, manager);
    await act(async () => {
      await chat.load();
      await drop(manager, "first.png");
      await drop(manager, "second.png");
    });

    const [removed] = manager.getState().complete;
    await act(async () => {
      if (removed !== undefined) await manager.remove(removed);
      await chat.flush();
    });
    const saved = await store.get({ scope: chatScope("chat-n") });
    expect(saved.draft?.attachments.map((ref) => ref.name)).toEqual(["second.png"]);
  });

  test("a send that fails before admission keeps the attachment in the composer and the draft, without reloading it", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new UnreachableBlobStore() });
    const chat = new DraftController({ store, scope: chatScope("chat-q"), timers: noTimers });
    const { shown } = renderComposer(chat, manager);
    const dropped = await act(async () => {
      await chat.load();
      return drop(manager, "photo.png");
    });
    act(() => shown.type("send this"));

    // A send names the chip by the id the composer gave it before the upload, with its name and media type only.
    const intent = {
      mode: "prompt" as const,
      text: "send this",
      delivery: "new" as const,
      attachmentRefs: [{ id: dropped.id, name: "photo.png", mediaType: "image/png" }],
    };
    await act(async () => {
      await expect(
        chat.submit(intent, async () => {
          throw new AppFailure({
            code: "unavailable",
            message: "The connection closed",
            retryable: true,
          });
        }),
      ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    });

    expect(manager.toDraftRefs().map((ref) => ref.name)).toEqual(["photo.png"]);
    expect(chat.getSnapshot().attachments.map((ref) => ref.name)).toEqual(["photo.png"]);
    expect(chat.getSnapshot().failedSends[0]?.attachments.map((ref) => ref.name)).toEqual([
      "photo.png",
    ]);
  });

  test("Enter on a chip whose upload has finished keeps the chip; the draft keeps it, and a reload restores it", async () => {
    const store = new ScopedDraftStore();
    // The server names a blob by its own id, not by the id the composer gave the file.
    const blobs = new MemoryBlobStore("blob-");
    const manager = new AttachmentManager({ blobStore: blobs });
    const chat = new DraftController({ store, scope: chatScope("chat-s1"), timers: noTimers });
    const { shown } = renderComposer(chat, manager);
    const dropped = await act(async () => {
      await chat.load();
      return drop(manager, "photo.png");
    });
    act(() => shown.type("send this"));

    // Enter names the chip the way the composer does: the id it had before the upload, with its name and media type.
    const intent = {
      mode: "prompt" as const,
      text: "send this",
      delivery: "new" as const,
      attachmentRefs: [{ id: dropped.id, name: "photo.png", mediaType: "image/png" }],
    };
    await act(async () => {
      await expect(
        chat.submit(intent, async () => {
          throw new AppFailure({
            code: "unavailable",
            message: "The connection closed",
            retryable: true,
          });
        }),
      ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    });

    // Nothing restores the chip from the composer's id, so the chip stays and the draft keeps its stored reference.
    expect(manager.toDraftRefs().map((ref) => ref.name)).toEqual(["photo.png"]);
    await act(async () => {
      await chat.flush();
    });
    const saved = await store.get({ scope: chatScope("chat-s1") });
    expect(saved.draft?.attachments.map((ref) => ref.id)).toEqual(
      manager.toDraftRefs().map((ref) => ref.id),
    );

    // After a reload, a new composer and controller over the same store restore the attachment.
    const reloadedManager = new AttachmentManager({ blobStore: blobs });
    const reloaded = new DraftController({ store, scope: chatScope("chat-s1"), timers: noTimers });
    renderComposer(reloaded, reloadedManager);
    await act(async () => {
      await reloaded.load();
    });
    await waitFor(() => {
      expect(reloadedManager.toDraftRefs().map((ref) => ref.name)).toEqual(["photo.png"]);
    });
  });

  test("a restore that stops at a blob it cannot read keeps the other attachments in the draft, so typing does not drop them", async () => {
    const store = new ScopedDraftStore();
    const blobs = new FlakyBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const first = new DraftController({ store, scope: chatScope("chat-p1"), timers: noTimers });
    const { shown, switchTo } = renderComposer(first, manager);
    await act(async () => {
      await first.load();
      await drop(manager, "notes.txt");
      await drop(manager, "missing.png");
    });

    // The chat is left, the blob of its second attachment is lost, and the chat is opened again: the restore stops there.
    blobs.lose("missing.png");
    const reopened = new DraftController({ store, scope: chatScope("chat-p1"), timers: noTimers });
    await act(async () => {
      await first.dispose();
      switchTo(reopened);
      await reopened.load();
    });
    await waitFor(() => {
      expect(manager.toDraftRefs().map((ref) => ref.name)).toEqual(["notes.txt"]);
    });

    // Typing saves the draft, and the attachment that could not be restored stays in it.
    act(() => shown.type("x"));
    await act(async () => {
      await reopened.flush();
    });
    const saved = await store.get({ scope: chatScope("chat-p1") });
    expect(saved.draft?.attachments.map((ref) => ref.name)).toEqual(["notes.txt", "missing.png"]);
  });

  test("an attachment dropped before the chat's draft loads is kept when the draft loads, and saved with it", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const chat = new DraftController({ store, scope: chatScope("chat-d1"), timers: noTimers });
    renderComposer(chat, manager);
    // The image is dropped while the chat's draft is still loading.
    await act(async () => {
      await drop(manager, "photo.png");
    });
    await act(async () => {
      await chat.load();
    });
    await waitFor(() => {
      expect(manager.toDraftRefs().map((ref) => ref.name)).toEqual(["photo.png"]);
    });
    await act(async () => {
      await chat.flush();
    });
    const saved = await store.get({ scope: chatScope("chat-d1") });
    expect(saved.draft?.attachments.map((ref) => ref.name)).toEqual(["photo.png"]);
  });

  test("a picture still loading when the chat's draft loads is kept, and saved once it is attached", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const chat = new DraftController({ store, scope: chatScope("chat-d5"), timers: noTimers });
    renderComposer(chat, manager);
    // The image is dropped, and its upload has not answered when the chat's draft loads.
    const loading = await act(async () =>
      manager.add({ file: new File(["png bytes"], "photo.png", { type: "image/png" }) }),
    );
    await act(async () => {
      await chat.load();
    });
    expect(manager.getState().pending.map((attachment) => attachment.id)).toEqual([loading.id]);
    await act(async () => {
      await manager.send(loading);
      await chat.flush();
    });
    const saved = await store.get({ scope: chatScope("chat-d5") });
    expect(saved.draft?.attachments.map((ref) => ref.name)).toEqual(["photo.png"]);
  });

  test("an attachment dropped before the chat's draft loads is saved when the chat is left, and comes back when it is opened again", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const first = new DraftController({ store, scope: chatScope("chat-d2"), timers: noTimers });
    const { switchTo } = renderComposer(first, manager);
    // The image is dropped, and the chat is left before its draft has loaded.
    await act(async () => {
      await drop(manager, "photo.png");
    });
    const second = new DraftController({ store, scope: chatScope("chat-d3"), timers: noTimers });
    await act(async () => {
      await first.dispose();
      switchTo(second);
      await second.load();
    });
    const back = new DraftController({ store, scope: chatScope("chat-d2"), timers: noTimers });
    await act(async () => {
      await second.dispose();
      switchTo(back);
      await back.load();
    });
    await waitFor(() => {
      expect(manager.toDraftRefs().map((ref) => ref.name)).toEqual(["photo.png"]);
    });
  });

  test("an attachment dropped before a chat with a stored draft has loaded is saved when the chat is left", async () => {
    const store = new ScopedDraftStore();
    // The chat already has a draft stored: a save from a chat whose draft has not loaded must not conflict with it.
    const earlier = new DraftController({ store, scope: chatScope("chat-d4"), timers: noTimers });
    await act(async () => {
      await earlier.load();
      earlier.setDraft("earlier text", []);
      await earlier.flush();
    });
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const chat = new DraftController({ store, scope: chatScope("chat-d4"), timers: noTimers });
    renderComposer(chat, manager);
    await act(async () => {
      await drop(manager, "photo.png");
    });
    await act(async () => {
      await chat.dispose();
    });
    const saved = await store.get({ scope: chatScope("chat-d4") });
    expect(saved.draft?.attachments.map((ref) => ref.name)).toEqual(["photo.png"]);
  });
});

/** Uploads that wait until `release()`: a picture that is still being attached when the test acts. */
class HeldUploadBlobStore extends MemoryBlobStore {
  private resume: (() => void) | undefined;

  override async put(input: {
    readonly id: string;
    readonly file: File;
  }): Promise<StoredAttachment> {
    await new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    return super.put(input);
  }

  release(): void {
    this.resume?.();
  }
}

describe("useComposerDraft: a picture still being attached, and the chat it was dropped in", () => {
  test("a move of the same chat's draft keeps the picture still being attached", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new HeldUploadBlobStore() });
    const first = new DraftController({ store, scope: chatScope("chat-v1"), timers: noTimers });
    const view = renderComposer(first, manager);
    const loading = await act(async () =>
      manager.add({ file: new File(["png bytes"], "photo.png", { type: "image/png" }) }),
    );
    // The chat's draft moves to another scope: another controller, the same chat.
    const moved = new DraftController({ store, scope: chatScope("chat-v2"), timers: noTimers });
    await act(async () => {
      view.switchTo(moved, view.chat);
    });
    expect(manager.getState().pending.map((attachment) => attachment.id)).toEqual([loading.id]);
  });

  test("switching to another chat drops the picture still being attached, and its late upload adds nothing", async () => {
    const store = new ScopedDraftStore();
    const blobs = new HeldUploadBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const first = new DraftController({ store, scope: chatScope("chat-v3"), timers: noTimers });
    const view = renderComposer(first, manager);
    const loading = await act(async () =>
      manager.add({ file: new File(["png bytes"], "photo.png", { type: "image/png" }) }),
    );
    const answer = manager.send(loading).catch((error: unknown) => error);
    const second = new DraftController({ store, scope: chatScope("chat-v4"), timers: noTimers });
    await act(async () => {
      view.switchTo(second);
    });
    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
    await act(async () => {
      blobs.release();
      expect(await answer).toMatchObject({ appError: { code: "cancelled" } });
    });
    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
    expect(manager.toDraftRefs()).toEqual([]);
  });

  test("leaving the chat (its composer goes) drops the picture still being attached", async () => {
    const store = new ScopedDraftStore();
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore() });
    const draft = new DraftController({ store, scope: chatScope("chat-v5"), timers: noTimers });
    const view = renderComposer(draft, manager);
    await act(async () => {
      await manager.add({ file: new File(["png bytes"], "photo.png", { type: "image/png" }) });
    });
    expect(manager.getState().pending).toHaveLength(1);
    await act(async () => {
      view.unmount();
    });
    expect(manager.getState().pending).toEqual([]);
  });
});

/** Reads of a blob that wait until `release()`: a picture that is still loading from its blob when the person moves on. */
class HeldReadBlobStore extends MemoryBlobStore {
  private resume: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.resume = resolve;
  });

  override async get(ref: AttachmentRef): Promise<StoredAttachment> {
    await this.gate;
    return super.get(ref);
  }

  release(): void {
    this.resume?.();
  }
}

describe("useComposerDraft: a picture still loading when the person moves to another chat", () => {
  test("it does not come into the chat opened next, nor into that chat's draft", async () => {
    const store = new ScopedDraftStore();
    const blobs = new HeldReadBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const first = new DraftController({ store, scope: chatScope("chat-r1"), timers: noTimers });
    const { shown, switchTo } = renderComposer(first, manager);
    await act(async () => {
      await first.load();
      await drop(manager, "photo.png");
    });

    // The chat is left, then opened again: its saved picture is still loading when the person moves on.
    const reopened = new DraftController({ store, scope: chatScope("chat-r1"), timers: noTimers });
    await act(async () => {
      await first.dispose();
      switchTo(reopened);
      await reopened.load();
    });
    const next = new DraftController({ store, scope: chatScope("chat-r2"), timers: noTimers });
    await act(async () => {
      await reopened.dispose();
      switchTo(next);
      await next.load();
    });
    await act(async () => {
      blobs.release();
    });

    // The picture belongs to chat r1: it does not reach the composer now that chat r2 is open.
    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
    // Typing in chat r2 saves its own draft, without the picture.
    act(() => shown.type("hi"));
    await act(async () => {
      await next.flush();
    });
    const saved = await store.get({ scope: chatScope("chat-r2") });
    expect(saved.draft?.attachments ?? []).toEqual([]);
  });
});

/** A real text box bound to the composer draft, so the caret can be read. */
function TextBox({ chat, controller }: { chat: object; controller: DraftController }) {
  const { text, composer } = useComposerText();
  useComposerDraft({
    chat,
    controller,
    text,
    composer,
    attachments: noAttachments,
    isRecalledPrompt: notRecalled,
  });
  return <textarea value={text} onChange={(event) => composer.setText(event.target.value)} />;
}

describe("useComposerDraft: the same chat's draft moving to another scope", () => {
  test("keeps the text and the caret where the person left them", async () => {
    const store = new ScopedDraftStore();
    const scope = chatScope("chat-caret");
    await store.save({
      scope,
      draft: { text: "ab", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = {};
    const first = new DraftController({ store, scope, timers: noTimers });
    const view = render(<TextBox chat={chat} controller={first} />);
    const box = document.querySelector("textarea");
    if (box === null) throw new Error("the text box is not rendered");
    await act(async () => {
      await first.load();
    });
    await waitFor(() => expect(box.value).toBe("ab"));
    act(() => box.setSelectionRange(1, 1));

    const second = new DraftController({ store, scope, timers: noTimers });
    view.rerender(<TextBox chat={chat} controller={second} />);
    await act(async () => {
      await second.load();
      await second.flush();
    });

    expect(box.value).toBe("ab");
    expect(box.selectionStart).toBe(1);
  });
});

describe("useComposerDraft: a send in flight (#2659)", () => {
  /** A composer whose send hold the test drives, as the composer's Enter and the send's end do. */
  function renderHolding(controller: DraftController) {
    const shown: ShownComposer = { text: "", type: () => undefined };
    const hold: { current: ComposerSendHold | null } = { current: null };
    const chat = {};
    function Holding() {
      const { text, composer } = useComposerText();
      shown.text = text;
      shown.type = composer.setText;
      hold.current = useComposerDraft({
        chat,
        controller,
        text,
        composer,
        attachments: noAttachments,
        isRecalledPrompt: notRecalled,
      });
      return null;
    }
    render(<Holding />);
    const send = (): ComposerSendHold => {
      if (hold.current === null) throw new Error("the composer did not render");
      return hold.current;
    };
    return { shown, send };
  }

  test("text typed as the send ends, before the box has drawn it, stays in the box and becomes the draft", async () => {
    const controller = new DraftController({
      store: new ScopedDraftStore(),
      scope: chatScope("chat-t"),
      timers: noTimers,
    });
    await controller.load();
    const { shown, send } = renderHolding(controller);
    await waitFor(() => expect(controller.getSnapshot().status).toBe("ready"));
    act(() => shown.type("first message"));
    await waitFor(() => expect(controller.getSnapshot().text).toBe("first message"));
    act(() => send().beginSend());
    await act(() =>
      controller.submit(
        { mode: "prompt", text: "first message", delivery: "new" },
        async () => undefined,
      ),
    );

    // The keystroke and the send's end land in one task: the hook has not rendered the typed text yet.
    act(() => {
      shown.type("typed as it ended");
      send().endSend();
    });
    expect(shown.text).toBe("typed as it ended");
    expect(controller.getSnapshot().text).toBe("typed as it ended");
  });

  test("text typed while the chat's draft is built again during the send goes to the draft the box shows", async () => {
    // A New chat's first send: its own store replaces the empty source it opened with, and the chat's draft is built
    // again while the send is in flight (#2646). The send's end comes from the render that took the Enter.
    const store = new ScopedDraftStore();
    const scope = chatScope("chat-r");
    const first = new DraftController({ store, scope, timers: noTimers });
    const rebuilt = new DraftController({ store, scope, timers: noTimers });
    await first.load();
    await rebuilt.load();
    const shown: ShownComposer = { text: "", type: () => undefined };
    const hold: { current: ComposerSendHold | null } = { current: null };
    function Composer({ chat, controller }: { chat: object; controller: DraftController }) {
      const { text, composer } = useComposerText();
      shown.text = text;
      shown.type = composer.setText;
      hold.current = useComposerDraft({
        chat,
        controller,
        text,
        composer,
        attachments: noAttachments,
        isRecalledPrompt: notRecalled,
      });
      return null;
    }
    const firstChat = {};
    const rebuiltChat = {};
    const view = render(<Composer chat={firstChat} controller={first} />);
    act(() => shown.type("first message"));
    await waitFor(() => expect(first.getSnapshot().text).toBe("first message"));
    const atEnter = hold.current;
    if (atEnter === null) throw new Error("the composer did not render");
    act(() => atEnter.beginSend());

    view.rerender(<Composer chat={rebuiltChat} controller={rebuilt} />);
    act(() => shown.type("typed during the send"));
    act(() => atEnter.endSend());
    expect(shown.text).toBe("typed during the send");
    expect(rebuilt.getSnapshot().text).toBe("typed during the send");
    expect(first.getSnapshot().text).not.toBe("typed during the send");
  });

  test("a draft that becomes ready during a send does not bring the sent text back into the box", async () => {
    // The New chat's draft moved into its thread just before the send, whose draft has not loaded yet. The send keeps its
    // text in that draft until admission, which makes the draft ready while the send is in flight.
    const first = new DraftController({
      store: new ScopedDraftStore(),
      scope: chatScope("chat-a"),
      timers: noTimers,
    });
    await first.load();
    const held = new HeldReadStore();
    const moved = new DraftController({
      store: held,
      scope: chatScope("chat-b"),
      timers: noTimers,
    });
    held.hold();
    const loading = moved.load();
    await held.waitUntilReadStarts();
    const shown: ShownComposer = { text: "", type: () => undefined };
    const hold: { current: ComposerSendHold | null } = { current: null };
    const chat = {};
    function Composer({ controller }: { controller: DraftController }) {
      const { text, composer } = useComposerText();
      shown.text = text;
      shown.type = composer.setText;
      hold.current = useComposerDraft({
        chat,
        controller,
        text,
        composer,
        attachments: noAttachments,
        isRecalledPrompt: notRecalled,
      });
      return null;
    }
    const view = render(<Composer controller={first} />);
    act(() => shown.type("queued follow-up"));
    view.rerender(<Composer controller={moved} />);
    const atEnter = hold.current;
    if (atEnter === null) throw new Error("the composer did not render");
    act(() => atEnter.beginSend());
    expect(shown.text).toBe("");

    const admitted = Promise.withResolvers<void>();
    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = moved.submit(
        { mode: "prompt", text: "queued follow-up", delivery: "followUp" },
        () => admitted.promise,
      );
    });
    expect(moved.getSnapshot().status).toBe("ready");
    expect(shown.text).toBe("");

    admitted.resolve();
    held.release();
    await act(async () => {
      await sent;
      await loading;
    });
    act(() => atEnter.endSend());
    await waitFor(() => expect(shown.text).toBe(""));
  });

  test("the box empties at Enter and takes new text, which the draft gets only once the send has settled", async () => {
    const controller = new DraftController({
      store: new ScopedDraftStore(),
      scope: chatScope("chat-s"),
      timers: noTimers,
    });
    await controller.load();
    const { shown, send } = renderHolding(controller);
    await waitFor(() => expect(controller.getSnapshot().status).toBe("ready"));
    act(() => shown.type("first message"));
    await waitFor(() => expect(controller.getSnapshot().text).toBe("first message"));

    act(() => send().beginSend());
    expect(shown.text).toBe("");
    act(() => shown.type("typed during the send"));
    // The draft keeps the sent text until the send settles: typed text joining it would go out again with it (#2645).
    expect(controller.getSnapshot().text).toBe("first message");

    await act(() =>
      controller.submit(
        { mode: "prompt", text: "first message", delivery: "new" },
        async () => undefined,
      ),
    );
    expect(shown.text).toBe("typed during the send");
    act(() => send().endSend());
    expect(controller.getSnapshot().text).toBe("typed during the send");
    expect(shown.text).toBe("typed during the send");
  });

  test("with nothing typed meanwhile, a failed send shows its text in the box again", async () => {
    const controller = new DraftController({
      store: new ScopedDraftStore(),
      scope: chatScope("chat-f"),
      timers: noTimers,
    });
    await controller.load();
    const { shown, send } = renderHolding(controller);
    await waitFor(() => expect(controller.getSnapshot().status).toBe("ready"));
    act(() => shown.type("refused message"));
    await waitFor(() => expect(controller.getSnapshot().text).toBe("refused message"));

    act(() => send().beginSend());
    expect(shown.text).toBe("");
    await act(async () => {
      await expect(
        controller.submit(
          { mode: "prompt", text: "refused message", delivery: "new" },
          async () => {
            throw new Error("refused");
          },
        ),
      ).rejects.toThrow("refused");
    });
    act(() => send().endSend());
    expect(shown.text).toBe("refused message");
  });
});
