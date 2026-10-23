import { AppFailure, type DraftScope, FolderPath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { ChatDraft, isCurrentUnsentChat, unsentChatReloadTarget } from "./chat-draft";
import { createDraftBuffer, type DraftBuffer, type DraftBufferStorage } from "./draft-buffer";
import type { DraftStoreAdapter, DraftTimer } from "./drafts";
import { ScopedDraftStore } from "./test-support";

/** The part of sessionStorage the draft buffer uses, kept in memory. */
class MemoryDraftStorage implements DraftBufferStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

// Autosave never fires in these tests: every write happens at a step the test takes, so each one is exact.
const noTimers: DraftTimer = { setTimeout: () => undefined, clearTimeout: () => undefined };
const folder = FolderPath.parse("/workspace/app");
const newChatDraft: DraftScope = { kind: "folder", folder };

function threadScope(id: string): DraftScope {
  return { kind: "thread", threadId: ThreadId.parse(id) };
}

function chatFor(store: DraftStoreAdapter, id: string): ChatDraft {
  return new ChatDraft({ store, folder, threadId: ThreadId.parse(id), timers: noTimers });
}

/** A prompt as the composer sends it, with the text the draft held. */
function prompt(text: string): PromptIntent {
  return { mode: "prompt", text, delivery: "new" };
}

describe("ChatDraft's New-chat reload target", () => {
  test("clears the saved chat while a new chat opens and when its thread id arrives", () => {
    const opening = unsentChatReloadTarget({
      savedThread: "chat-saved",
      unsentMarker: null,
    });
    expect(opening).toEqual({ savedThread: null, unsentMarker: "opening" });

    const ready = unsentChatReloadTarget(
      { savedThread: "chat-saved", unsentMarker: opening.unsentMarker },
      ThreadId.parse("chat-new"),
    );
    expect(ready).toEqual({ savedThread: null, unsentMarker: "chat-new" });
  });
  test("a stale chat observer cannot replace the active New-chat marker", () => {
    const previous = ThreadId.parse("chat-previous");
    const current = ThreadId.parse("chat-current");

    expect(isCurrentUnsentChat(current, current, current)).toBe(true);
    expect(isCurrentUnsentChat(previous, null, previous)).toBe(false);
  });
});

describe("ChatDraft: a chat with no prompt yet", () => {
  test("keeps its text in the folder's new-chat draft, not in a draft of its own", async () => {
    const store = new ScopedDraftStore();
    const chat = chatFor(store, "chat-b");
    await chat.controller.load();
    chat.controller.setDraft("unsent draft B", []);

    chat.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() => expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft));
    expect(chat.controller.getSnapshot().text).toBe("unsent draft B");
    await chat.controller.flush();

    expect(store.text(newChatDraft)).toBe("unsent draft B");
    expect(store.text(threadScope("chat-b"))).toBeUndefined();
  });

  test("the next new chat in the folder shows the text the last unsent chat left", async () => {
    const store = new ScopedDraftStore();
    const first = chatFor(store, "chat-b");
    await first.controller.load();
    first.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() => expect(first.controller.getSnapshot().scope).toEqual(newChatDraft));
    first.controller.setDraft("unsent draft B", []);
    await first.controller.flush();
    first.dispose();

    const next = chatFor(store, "chat-c");
    await next.controller.load();
    next.observe({ loaded: true, hasMessages: false });

    await vi.waitFor(() => expect(next.controller.getSnapshot().text).toBe("unsent draft B"));
    expect(next.controller.getSnapshot().scope).toEqual(newChatDraft);
  });

  test("text typed while its history loads moves to the folder draft, after the text already there", async () => {
    const store = new ScopedDraftStore();
    await store.save({
      scope: newChatDraft,
      draft: { text: "unsent draft B", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = chatFor(store, "chat-d");
    await chat.controller.load();
    chat.observe({ loaded: false, hasMessages: false });
    expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-d"));
    chat.controller.setDraft("typed while loading", []);

    chat.observe({ loaded: true, hasMessages: false });

    await vi.waitFor(() => expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft));
    expect(chat.controller.getSnapshot().text).toBe("unsent draft B\n\ntyped while loading");
    await chat.controller.flush();
    expect(store.text(newChatDraft)).toBe("unsent draft B\n\ntyped while loading");
    expect(store.text(threadScope("chat-d"))).toBeUndefined();
  });

  test("a folder with no chat open has no new-chat draft, so the chat keeps its own", async () => {
    const store = new ScopedDraftStore();
    const chat = new ChatDraft({
      store,
      folder: null,
      threadId: ThreadId.parse("chat-e"),
      timers: noTimers,
    });
    await chat.controller.load();
    chat.controller.setDraft("own draft", []);
    chat.observe({ loaded: true, hasMessages: false });
    await chat.controller.flush();
    expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-e"));
    expect(store.text(threadScope("chat-e"))).toBe("own draft");
  });

  test("a chat opened as new keeps the text typed before its history loads in the folder's new-chat draft", async () => {
    const store = new ScopedDraftStore();
    const chat = new ChatDraft({
      store,
      folder,
      threadId: ThreadId.parse("chat-n"),
      startsUnsent: true,
      timers: noTimers,
    });
    await chat.controller.load();
    expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft);
    chat.controller.setDraft("typed in the first second", []);
    await chat.controller.flush();
    expect(store.text(newChatDraft)).toBe("typed in the first second");
    expect(store.text(threadScope("chat-n"))).toBeUndefined();
  });
});

describe("ChatDraft: a chat that has messages", () => {
  test("keeps its own draft and never reads the new-chat draft", async () => {
    const store = new ScopedDraftStore();
    await store.save({
      scope: newChatDraft,
      draft: { text: "unsent draft B", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = chatFor(store, "chat-a");
    await chat.controller.load();
    chat.observe({ loaded: true, hasMessages: true });
    expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-a"));
    expect(chat.controller.getSnapshot().text).toBe("");

    chat.controller.setDraft("A draft", []);
    await chat.controller.flush();

    expect(store.text(threadScope("chat-a"))).toBe("A draft");
    expect(store.text(newChatDraft)).toBe("unsent draft B");
  });

  test("a prompt sent from the new-chat draft clears it, and later drafts are the chat's own", async () => {
    const store = new ScopedDraftStore();
    const chat = chatFor(store, "chat-d");
    await chat.controller.load();
    chat.controller.setDraft("draft to send", []);
    chat.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() => expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft));
    await chat.controller.flush();

    let scopeWhileSending: DraftScope | undefined;
    await chat.submit(prompt("draft to send"), async () => {
      scopeWhileSending = chat.controller.getSnapshot().scope;
      // The runtime store now holds the sent message, as the hook reports it.
      chat.observe({ loaded: true, hasMessages: true });
    });

    expect(scopeWhileSending).toEqual(newChatDraft);
    await vi.waitFor(() =>
      expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-d")),
    );
    expect(store.text(newChatDraft)).toBeUndefined();
    chat.controller.setDraft("follow-up", []);
    await chat.controller.flush();
    expect(store.text(threadScope("chat-d"))).toBe("follow-up");
    expect(store.text(newChatDraft)).toBeUndefined();
  });

  test("text typed while its first prompt is admitted goes with the chat, not back to the new-chat draft", async () => {
    const store = new ScopedDraftStore();
    const chat = chatFor(store, "chat-f");
    await chat.controller.load();
    chat.controller.setDraft("first prompt", []);
    chat.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() => expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft));
    await chat.controller.flush();

    await chat.submit(prompt("first prompt"), async () => {
      chat.controller.setDraft("typed during the send", []);
      chat.observe({ loaded: true, hasMessages: true });
    });

    await vi.waitFor(() =>
      expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-f")),
    );
    expect(chat.controller.getSnapshot().text).toBe("typed during the send");
    await chat.controller.flush();
    expect(store.text(threadScope("chat-f"))).toBe("typed during the send");
    expect(store.text(newChatDraft)).toBeUndefined();
  });
});

describe("ChatDraft: a move that fails", () => {
  test("reports the failure on the draft the composer holds, and keeps the text where it was", async () => {
    class UnreadableFolderStore extends ScopedDraftStore {
      override async get(args: { readonly scope: DraftScope }) {
        if (args.scope.kind === "folder") {
          throw new AppFailure({
            code: "unavailable",
            message: "The store is down",
            retryable: true,
          });
        }
        return super.get(args);
      }
    }
    const chat = chatFor(new UnreadableFolderStore(), "chat-g");
    await chat.controller.load();
    chat.controller.setDraft("kept text", []);

    chat.observe({ loaded: true, hasMessages: false });

    await vi.waitFor(() => expect(chat.controller.getSnapshot().status).toBe("error"));
    expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-g"));
    expect(chat.controller.getSnapshot().text).toBe("kept text");
  });
});

describe("ChatDraft: a prompt sent while its draft moves", () => {
  test("waits for the move, then sends from the draft that now holds the text, and leaves nothing behind", async () => {
    class GatedClearStore extends ScopedDraftStore {
      private readonly clearGate = Promise.withResolvers<void>();
      releaseClear(): void {
        this.clearGate.resolve();
      }
      override async clear(args: Parameters<ScopedDraftStore["clear"]>[0]) {
        if (args.scope.kind === "folder") await this.clearGate.promise;
        return super.clear(args);
      }
    }
    const store = new GatedClearStore();
    await store.save({
      scope: newChatDraft,
      draft: { text: "queue two", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = chatFor(store, "chat-v");
    await chat.controller.load();
    chat.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() =>
      expect(chat.controller.getSnapshot()).toMatchObject({
        scope: newChatDraft,
        text: "queue two",
      }),
    );

    // The first prompt lands, so the draft starts to move to the chat; a follow-up is sent before it finishes.
    chat.observe({ loaded: true, hasMessages: true });
    const sentFrom: { scope: DraftScope; text: string }[] = [];
    const sending = chat.submit(prompt("queue two"), async () => {
      const snapshot = chat.controller.getSnapshot();
      sentFrom.push({ scope: snapshot.scope, text: snapshot.text });
    });
    store.releaseClear();
    await sending;

    expect(sentFrom).toEqual([{ scope: threadScope("chat-v"), text: "queue two" }]);
    expect(chat.controller.getSnapshot()).toMatchObject({
      scope: threadScope("chat-v"),
      text: "",
      status: "ready",
    });
    expect(store.text(newChatDraft)).toBeUndefined();
    expect(store.text(threadScope("chat-v"))).toBeUndefined();
  });
});

describe("ChatDraft: unsaved text kept in this tab", () => {
  test("the text of a new chat is kept in the buffer of the folder draft it is in, so the app's restart cannot lose it", async () => {
    const store = new ScopedDraftStore();
    const storage = new MemoryDraftStorage();
    const quiet = (): void => undefined;
    const chat = new ChatDraft({
      store,
      folder,
      threadId: ThreadId.parse("chat-x"),
      timers: noTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await chat.controller.load();
    chat.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() => expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft));

    chat.controller.setDraft("typed in the new chat", []);

    expect(createDraftBuffer(storage, quiet).read(newChatDraft)?.input.text).toBe(
      "typed in the new chat",
    );
  });
});

describe("ChatDraft: a failed step is retried, a conflict waits for a choice", () => {
  test("a move the store could not load is re-run by retry, and the text moves once the store answers", async () => {
    class FlakyFolderGet extends ScopedDraftStore {
      private failures = 1;
      override async get(args: { readonly scope: DraftScope }) {
        if (args.scope.kind === "folder" && this.failures > 0) {
          this.failures -= 1;
          throw new AppFailure({
            code: "unavailable",
            message: "The store is down",
            retryable: true,
          });
        }
        return super.get(args);
      }
    }
    const chat = chatFor(new FlakyFolderGet(), "chat-h");
    await chat.controller.load();
    chat.controller.setDraft("kept text", []);
    chat.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() => expect(chat.controller.getSnapshot().status).toBe("error"));
    expect(chat.controller.getSnapshot()).toMatchObject({
      scope: threadScope("chat-h"),
      text: "kept text",
    });

    chat.retry();

    await vi.waitFor(() => expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft));
    expect(chat.controller.getSnapshot()).toMatchObject({ status: "ready", text: "kept text" });
  });

  test("a conflict that stops a move waits for the person's choice, and the choice runs the move again", async () => {
    class ConflictOnFirstFolderClear extends ScopedDraftStore {
      private conflicts = 1;
      override async clear(args: Parameters<ScopedDraftStore["clear"]>[0]) {
        if (args.scope.kind === "folder" && this.conflicts > 0) {
          this.conflicts -= 1;
          return { cleared: false, revision: null };
        }
        return super.clear(args);
      }
    }
    const store = new ConflictOnFirstFolderClear();
    await store.save({
      scope: newChatDraft,
      draft: { text: "folder text", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = chatFor(store, "chat-k");
    await chat.controller.load();
    chat.observe({ loaded: true, hasMessages: false });
    await vi.waitFor(() => expect(chat.controller.getSnapshot().scope).toEqual(newChatDraft));
    chat.controller.setDraft("typed while the chat was new", []);

    chat.observe({ loaded: true, hasMessages: true });

    await vi.waitFor(() => expect(chat.controller.getSnapshot().status).toBe("conflict"));
    expect(chat.controller.getSnapshot().conflict).toMatchObject({
      local: { text: "typed while the chat was new" },
      remote: { text: "folder text" },
    });

    await chat.resolveConflict("local");

    await vi.waitFor(() =>
      expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-k")),
    );
    expect(chat.controller.getSnapshot().text).toBe("typed while the chat was new");
    expect(store.text(newChatDraft)).toBeUndefined();
  });
});

describe("ChatDraft: a send whose admission a reload beat", () => {
  const quiet = (): void => undefined;
  /** Lets the queued moves and drafts settle. Each step is a promise, so a fixed number of turns is exact, not a guess at time. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  }

  /** The page before the reload: a New chat sends a prompt, and the send is held until the test releases it. */
  async function sendBeforeReload(store: ScopedDraftStore, buffer: DraftBuffer) {
    const sending = new ChatDraft({
      store,
      folder,
      threadId: ThreadId.parse("chat-new"),
      startsUnsent: true,
      timers: noTimers,
      buffer,
    });
    await sending.controller.load();
    const release = Promise.withResolvers<void>();
    const sent = sending.submit(prompt("sent then reloaded"), () => release.promise);
    await vi.waitFor(() =>
      expect(buffer.read(newChatDraft)?.input.text).toBe("sent then reloaded"),
    );
    return { release, sent };
  }

  /**
   * The page after the reload. A static import would share one module instance with the page before it, whose held
   * write would then block this page's loads; a reload starts with nothing in memory, so the module is loaded again.
   */
  async function reloadedChat(
    store: ScopedDraftStore,
    buffer: DraftBuffer,
    transcript: string[],
  ): Promise<ChatDraft> {
    vi.resetModules();
    const fresh = await import("./chat-draft");
    return new fresh.ChatDraft({
      store,
      folder,
      threadId: ThreadId.parse("chat-saved"),
      timers: noTimers,
      buffer,
      userPrompts: () => transcript,
    });
  }

  test("the saved chat is not new while its prompt is on its way, so the copy stays in the folder", async () => {
    const store = new ScopedDraftStore();
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { release, sent } = await sendBeforeReload(store, buffer);
    const chat = await reloadedChat(store, buffer, []);
    await chat.controller.load();

    chat.observe({ loaded: true, hasMessages: false });
    await settle();

    expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-saved"));
    expect(buffer.read(newChatDraft)?.input.text).toBe("sent then reloaded");
    expect(store.text(threadScope("chat-saved"))).toBeUndefined();
    release.resolve();
    await sent;
  });

  test("once the transcript shows the send, its copy is dropped, and the saved chat never takes it", async () => {
    const store = new ScopedDraftStore();
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { release, sent } = await sendBeforeReload(store, buffer);
    const transcript: string[] = [];
    const chat = await reloadedChat(store, buffer, transcript);
    await chat.controller.load();
    chat.observe({ loaded: true, hasMessages: false });
    await settle();

    transcript.push("sent then reloaded");
    chat.observe({ loaded: true, hasMessages: true });
    await vi.waitFor(() => expect(buffer.read(newChatDraft)).toBeNull());
    await settle();

    expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-saved"));
    expect(chat.controller.getSnapshot().text).toBe("");
    expect(store.text(newChatDraft)).toBeUndefined();
    expect(store.text(threadScope("chat-saved"))).toBeUndefined();
    release.resolve();
    await sent;
  });

  test("a New chat's typed text that equals a prompt of the saved chat is not dropped", async () => {
    const store = new ScopedDraftStore();
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    await store.save({
      scope: newChatDraft,
      draft: { text: "continue", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const chat = new ChatDraft({
      store,
      folder,
      threadId: ThreadId.parse("chat-saved"),
      timers: noTimers,
      buffer,
      userPrompts: () => ["continue"],
    });
    await chat.controller.load();

    chat.observe({ loaded: true, hasMessages: true });
    await settle();

    expect(chat.controller.getSnapshot().text).toBe("");
    expect(store.text(newChatDraft)).toBe("continue");
  });

  test("a send keeps its record while it waits, and drops it once the send is admitted", async () => {
    const store = new ScopedDraftStore();
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { release, sent } = await sendBeforeReload(store, buffer);
    expect(buffer.readSent(newChatDraft)).toBe("sent then reloaded");

    release.resolve();
    await sent;

    expect(buffer.readSent(newChatDraft)).toBeNull();
    expect(buffer.read(newChatDraft)).toBeNull();
  });

  test("a send that fails drops its record, and its text stays as a failed send", async () => {
    const store = new ScopedDraftStore();
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const chat = new ChatDraft({
      store,
      folder,
      threadId: ThreadId.parse("chat-new"),
      startsUnsent: true,
      timers: noTimers,
      buffer,
    });
    await chat.controller.load();
    const refused = new AppFailure({
      code: "internal",
      message: "The prompt was refused",
      retryable: true,
    });

    await expect(
      chat.submit(prompt("refused prompt"), async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);

    expect(buffer.readSent(newChatDraft)).toBeNull();
    expect(chat.controller.getSnapshot().failedSends).toHaveLength(1);
  });
});

describe("ChatDraft: text typed while a chat's first answer moves its draft (#2306)", () => {
  test("text typed while the chat's saved draft is read goes to the chat, not to the New-chat draft", async () => {
    const read = Promise.withResolvers<void>();
    class HeldChatRead extends ScopedDraftStore {
      override async get(args: { readonly scope: DraftScope }) {
        if (args.scope.kind === "thread") await read.promise;
        return super.get(args);
      }
    }
    const store = new HeldChatRead();
    const chat = new ChatDraft({
      store,
      folder,
      threadId: ThreadId.parse("chat-answered"),
      startsUnsent: true,
      timers: noTimers,
    });
    await chat.controller.load();

    chat.observe({ loaded: true, hasMessages: true });
    await vi.waitFor(() =>
      expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-answered")),
    );
    chat.controller.setDraft("typed after the answer", []);
    read.resolve();

    expect(chat.controller.getSnapshot()).toMatchObject({
      scope: threadScope("chat-answered"),
      text: "typed after the answer",
    });
    expect((await store.get({ scope: newChatDraft })).draft).toBeNull();
  });

  test("a chat whose saved draft cannot be read keeps the text, shows the error there, and retries the read", async () => {
    const read = Promise.withResolvers<void>();
    class FlakyChatRead extends ScopedDraftStore {
      private failures = 1;
      override async get(args: { readonly scope: DraftScope }) {
        if (args.scope.kind !== "thread" || this.failures === 0) return super.get(args);
        this.failures -= 1;
        await read.promise;
        throw new AppFailure({
          code: "unavailable",
          message: "The store is down",
          retryable: true,
        });
      }
    }
    const chat = new ChatDraft({
      store: new FlakyChatRead(),
      folder,
      threadId: ThreadId.parse("chat-unreadable"),
      startsUnsent: true,
      timers: noTimers,
    });
    await chat.controller.load();

    chat.observe({ loaded: true, hasMessages: true });
    await vi.waitFor(() =>
      expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-unreadable")),
    );
    chat.controller.setDraft("typed while the chat is read", []);
    read.resolve();

    await vi.waitFor(() => expect(chat.controller.getSnapshot().status).toBe("error"));
    expect(chat.controller.getSnapshot()).toMatchObject({
      scope: threadScope("chat-unreadable"),
      text: "typed while the chat is read",
    });

    chat.retry();

    await vi.waitFor(() => expect(chat.controller.getSnapshot().status).toBe("ready"));
    expect(chat.controller.getSnapshot()).toMatchObject({
      scope: threadScope("chat-unreadable"),
      text: "typed while the chat is read",
    });
  });

  test("text written in the New chat before the answer comes first, ahead of text typed while the chat's read is held", async () => {
    const read = Promise.withResolvers<void>();
    class HeldChatRead extends ScopedDraftStore {
      override async get(args: { readonly scope: DraftScope }) {
        if (args.scope.kind === "thread") await read.promise;
        return super.get(args);
      }
    }
    const chat = new ChatDraft({
      store: new HeldChatRead(),
      folder,
      threadId: ThreadId.parse("chat-ordered"),
      startsUnsent: true,
      timers: noTimers,
    });
    await chat.controller.load();
    chat.controller.setDraft("written before the answer", []);

    chat.observe({ loaded: true, hasMessages: true });
    await vi.waitFor(() =>
      expect(chat.controller.getSnapshot().scope).toEqual(threadScope("chat-ordered")),
    );
    chat.controller.setDraft(`${chat.controller.getSnapshot().text} and after`, []);
    read.resolve();

    await vi.waitFor(() => expect(chat.controller.getSnapshot().status).toBe("ready"));
    expect(chat.controller.getSnapshot()).toMatchObject({
      scope: threadScope("chat-ordered"),
      text: "written before the answer and after",
    });
  });
});
