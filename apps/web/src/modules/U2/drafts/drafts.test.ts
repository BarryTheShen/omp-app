import type { AttachmentRef, Draft, DraftChanged, DraftScope, Revision } from "@omp-app/contracts";
import { AppFailure, FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { createDraftBuffer, type DraftBuffer, type DraftBufferStorage } from "./draft-buffer";
import {
  DraftController,
  type DraftLifecycleTarget,
  type DraftStoreAdapter,
  type DraftTimer,
} from "./drafts";
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
const scope: DraftScope = { kind: "thread", threadId: "thread-drafts" as never };
const attachment: AttachmentRef = {
  id: "blob-1",
  name: "notes.txt",
  mediaType: "text/plain",
  uri: "attachment://blob-1",
};

class FakeTimers implements DraftTimer {
  private next = 0;
  private readonly tasks = new Map<number, () => void>();
  setTimeout(callback: () => void): number {
    const id = ++this.next;
    this.tasks.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  async runAll(): Promise<void> {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task();
    await Promise.resolve();
    await Promise.resolve();
  }
}

class FakeLifecycle implements DraftLifecycleTarget {
  document = { visibilityState: "visible" };
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: "visibilitychange" | "pagehide", listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: "visibilitychange" | "pagehide", listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: "visibilitychange" | "pagehide"): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeDraftStore implements DraftStoreAdapter {
  draft: Draft | null = null;
  readonly saves: Array<{ expectedRevision: Revision | null; draft: unknown }> = [];
  clearCount = 0;
  conflictNextSave = false;
  private revision = 0;
  private readonly listeners = new Set<(change: DraftChanged) => void>();

  async get(): Promise<{ draft: Draft | null }> {
    return { draft: this.draft };
  }
  async save(args: {
    draft: { text: string; attachments: readonly AttachmentRef[]; failedSends: readonly unknown[] };
    expectedRevision: Revision | null;
  }): Promise<Draft> {
    this.saves.push({ expectedRevision: args.expectedRevision, draft: args.draft });
    if (this.conflictNextSave) {
      this.conflictNextSave = false;
      throw new AppFailure({ code: "conflict", message: "changed", retryable: true });
    }
    const revision = `r${++this.revision}` as Revision;
    this.draft = {
      scope,
      text: args.draft.text,
      attachments: [...args.draft.attachments],
      failedSends: args.draft.failedSends as Draft["failedSends"],
      revision,
      updatedAt: new Date(1).toISOString(),
    };
    return this.draft;
  }
  async clear(): Promise<{ cleared: boolean; revision: Revision | null }> {
    this.clearCount += 1;
    this.draft = null;
    return { cleared: true, revision: null };
  }
  subscribeChanged(_scope: DraftScope, listener: (change: DraftChanged) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(draft: Draft | null): void {
    const change = { scope, draft };
    for (const listener of this.listeners) listener(change);
  }
}
type ClearOutcome = "success" | "notCleared";

class GatedClearStore extends ScopedDraftStore {
  clearStarted = false;
  private readonly outcome: ClearOutcome;
  private pending:
    | {
        readonly args: Parameters<ScopedDraftStore["clear"]>[0];
        readonly resolve: (result: { cleared: boolean; revision: string | null }) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;

  public constructor(outcome: ClearOutcome = "success") {
    super();
    this.outcome = outcome;
  }
  private getHeld = false;
  private pendingGet:
    | {
        readonly args: Parameters<ScopedDraftStore["get"]>[0];
        readonly resolve: (result: Awaited<ReturnType<ScopedDraftStore["get"]>>) => void;
      }
    | undefined;

  gateGet(): void {
    this.getHeld = true;
  }

  override get(
    args: Parameters<ScopedDraftStore["get"]>[0],
  ): Promise<Awaited<ReturnType<ScopedDraftStore["get"]>>> {
    if (!this.getHeld) return super.get(args);
    this.getStarted = true;
    const { promise, resolve } =
      Promise.withResolvers<Awaited<ReturnType<ScopedDraftStore["get"]>>>();
    this.pendingGet = { args, resolve };
    return promise;
  }

  getStarted = false;

  releaseGet(): void {
    const pending = this.pendingGet;
    this.pendingGet = undefined;
    this.getHeld = false;
    if (pending === undefined) throw new Error("get was not pending");
    void super.get(pending.args).then(pending.resolve);
  }

  override clear(
    args: Parameters<ScopedDraftStore["clear"]>[0],
  ): Promise<{ cleared: boolean; revision: string | null }> {
    this.clearStarted = true;
    const { promise, resolve, reject } = Promise.withResolvers<{
      cleared: boolean;
      revision: string | null;
    }>();
    this.pending = { args, resolve, reject };
    return promise;
  }

  release(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) throw new Error("clear was not pending");
    if (this.outcome === "notCleared") {
      pending.resolve({ cleared: false, revision: null });
      return;
    }
    void super.clear(pending.args).then(pending.resolve, pending.reject);
  }

  reject(error: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) throw new Error("clear was not pending");
    pending.reject(error);
  }
}

function prompt(text: string): PromptIntent {
  return { mode: "prompt", text, delivery: "new" };
}

describe("U2.4 DraftController", () => {
  test("debounces dirty saves to the ten-second timer", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    controller.setDraft("hello", [attachment]);
    expect(store.saves).toHaveLength(0);
    await timers.runAll();
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.draft).toMatchObject({ text: "hello", attachments: [attachment] });
  });

  test("keeps text typed while the draft is still loading and saves against the stored revision", async () => {
    const timers = new FakeTimers();
    const storage = new MemoryDraftStorage();
    const store = new FakeDraftStore();
    const quiet = (): void => undefined;
    store.draft = {
      scope,
      text: "older draft",
      attachments: [],
      failedSends: [],
      revision: "r0" as Revision,
      updatedAt: new Date(1).toISOString(),
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = store.get.bind(store);
    store.get = async () => {
      await gate;
      return read();
    };
    const controller = new DraftController({
      store,
      scope,
      timers,
      buffer: createDraftBuffer(storage, quiet),
    });
    const loading = controller.load();
    controller.setDraft("typed first", []);
    expect(createDraftBuffer(storage, quiet).read(scope)?.input.text).toBe("typed first");
    release();
    await loading;
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      text: "typed first",
      dirty: true,
      revision: "r0",
      conflict: null,
    });
    await timers.runAll();
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]).toMatchObject({
      expectedRevision: "r0",
      draft: { text: "typed first" },
    });
    expect(controller.getSnapshot().conflict).toBeNull();
  });

  test("keeps text typed while the draft is loading when nothing is stored", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = store.get.bind(store);
    store.get = async () => {
      await gate;
      return read();
    };
    const controller = new DraftController({ store, scope, timers });
    const loading = controller.load();
    controller.setDraft("typed first", [attachment]);
    release();
    await loading;
    expect(controller.getSnapshot()).toMatchObject({
      text: "typed first",
      attachments: [attachment],
      dirty: true,
      revision: null,
    });
  });

  test("flushes immediately on pagehide and ignores visible visibility changes", async () => {
    const timers = new FakeTimers();
    const lifecycle = new FakeLifecycle();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers, lifecycle });
    await controller.load();
    controller.setDraft("hidden", []);
    lifecycle.emit("visibilitychange");
    await Promise.resolve();
    expect(store.saves).toHaveLength(0);
    lifecycle.emit("pagehide");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.saves).toHaveLength(1);
  });
  test("captures the composer's current value before the pagehide flush", async () => {
    const timers = new FakeTimers();
    const lifecycle = new FakeLifecycle();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers, lifecycle });
    await controller.load();
    controller.setDraft("rendered", []);
    await timers.runAll();
    controller.setLifecycleReader({
      read: () => ({ text: "latest", attachments: [] }),
    });
    lifecycle.emit("pagehide");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.draft?.text).toBe("latest");
  });

  test("saves text typed during a slow save once that save lands, without another keystroke", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const release = Promise.withResolvers<void>();
    const save = store.save.bind(store);
    let slow = true;
    store.save = async (args: Parameters<typeof save>[0]) => {
      if (slow) {
        slow = false;
        await release.promise;
      }
      return save(args);
    };
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    controller.setDraft("one", []);
    await timers.runAll(); // the autosave starts the first save, which waits for release
    controller.setDraft("one two", []); // typed while that save is in flight
    await timers.runAll(); // its timer fires: the flush joins the save in flight and starts none
    release.resolve();
    await controller.flush(); // joins the save in flight: it has landed with "one" when this returns
    await timers.runAll(); // the timer the landed save leaves behind, if any
    expect(store.draft?.text).toBe("one two");
  });

  test("turns a CAS conflict into a visible local/remote choice", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    controller.setDraft("local", []);
    store.conflictNextSave = true;
    store.draft = {
      scope,
      text: "remote",
      attachments: [attachment],
      failedSends: [],
      revision: "remote-r" as Revision,
      updatedAt: new Date(2).toISOString(),
    };
    await timers.runAll();
    expect(controller.getSnapshot().status).toBe("conflict");
    expect(controller.getSnapshot().conflict?.local.text).toBe("local");
    await controller.resolveConflict("remote");
    expect(controller.getSnapshot()).toMatchObject({ text: "remote" });
  });

  test("typing while a conflict shows keeps the choice on screen, and the local side is what was typed last", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    controller.setDraft("local", []);
    store.conflictNextSave = true;
    store.draft = {
      scope,
      text: "remote",
      attachments: [],
      failedSends: [],
      revision: "remote-r" as Revision,
      updatedAt: new Date(2).toISOString(),
    };
    await timers.runAll();
    expect(controller.getSnapshot().status).toBe("conflict");

    const savesBefore = store.saves.length;
    controller.setDraft("local, typed on", []);
    await timers.runAll();

    expect(controller.getSnapshot().status).toBe("conflict");
    expect(controller.getSnapshot().conflict?.local.text).toBe("local, typed on");
    expect(store.saves).toHaveLength(savesBefore);
    await controller.resolveConflict("local");
    expect(store.draft?.text).toBe("local, typed on");
  });

  test("restores a saved draft after a new controller loads the same scope", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const first = new DraftController({ store, scope, timers });
    await first.load();
    first.setDraft("reload me", [attachment]);
    await timers.runAll();
    const second = new DraftController({ store, scope, timers });
    await second.load();
    expect(second.getSnapshot()).toMatchObject({
      text: "reload me",
      attachments: [attachment],
      dirty: false,
    });
  });

  test("clears only after admission and records pre-admission failures", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    const failure = new AppFailure({ code: "permission", message: "rejected", retryable: false });
    await expect(
      controller.submit(prompt("keep"), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(store.clearCount).toBe(0);
    expect(controller.getSnapshot().failedSends).toHaveLength(1);
    await controller.submit(prompt("admitted"), async () => undefined);
    await expect.poll(() => store.clearCount).toBe(1);
    expect(controller.getSnapshot().text).toBe("");
  });

  test("an admitted `!` command clears the draft and its failed sends, as a prompt does", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    const failure = new AppFailure({ code: "permission", message: "rejected", retryable: false });
    await expect(
      controller.submit(prompt("keep"), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(controller.getSnapshot().failedSends).toHaveLength(1);
    await controller.submit({ mode: "bash", text: "pwd", delivery: "new" }, async () => undefined);
    await expect.poll(() => store.clearCount).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ text: "", failedSends: [] });
  });

  test("an admitted `$` command clears the draft and its failed sends, as a prompt does", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    const failure = new AppFailure({ code: "permission", message: "rejected", retryable: false });
    await expect(
      controller.submit(prompt("keep"), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(controller.getSnapshot().failedSends).toHaveLength(1);
    await controller.submit(
      { mode: "python", text: "print(1)", delivery: "new" },
      async () => undefined,
    );
    await expect.poll(() => store.clearCount).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ text: "", failedSends: [] });
  });

  test("keeps the typed mode prefix of a refused command line in the draft", async () => {
    const timers = new FakeTimers();
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    const failure = new AppFailure({ code: "unavailable", message: "refused", retryable: false });
    await expect(
      controller.submit(
        { mode: "bash", text: "echo excluded-out", delivery: "new", excludeFromContext: true },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(controller.getSnapshot().text).toBe("!!echo excluded-out");
    expect(controller.getSnapshot().failedSends[0]?.text).toBe("!!echo excluded-out");
  });

  test("ignores an earlier echo of this controller's own save after a newer save", async () => {
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope });
    await controller.load();
    controller.setDraft("first", []);
    await controller.flush();
    const firstSave = store.draft;
    controller.setDraft("second", []);
    await controller.flush();
    expect(firstSave).not.toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      text: "second",
      dirty: false,
      status: "ready",
    });
    store.emit(firstSave);
    expect(controller.getSnapshot()).toMatchObject({
      text: "second",
      dirty: false,
      status: "ready",
    });
  });
  test("turns another tab's scoped change into a conflict while dirty and adopts it while clean", async () => {
    const store = new FakeDraftStore();
    const controller = new DraftController({ store, scope });
    await controller.load();
    controller.setDraft("mine", []);
    const remote: Draft = {
      scope,
      text: "theirs",
      attachments: [attachment],
      failedSends: [],
      revision: "r-remote" as Revision,
      updatedAt: new Date(3).toISOString(),
    };
    store.emit(remote);
    expect(controller.getSnapshot().status).toBe("conflict");
    await controller.resolveConflict("remote");
    store.emit({ ...remote, text: "newer", revision: "r-newer" as Revision });
    expect(controller.getSnapshot()).toMatchObject({ text: "newer", dirty: false });
  });
});

const idleTimers: DraftTimer = { setTimeout: () => undefined, clearTimeout: () => undefined };

describe("DraftController: writes and clears across controllers", () => {
  test("clearing a draft that was never stored resets it locally, without a conflict", async () => {
    const store = new ScopedDraftStore();
    const controller = new DraftController({
      store,
      scope: { kind: "folder", folder: FolderPath.parse("/workspace/app") },
      timers: idleTimers,
    });
    await controller.load();
    controller.setDraft("sent before the autosave", []);

    await controller.clearAfterAdmission("sent before the autosave");

    expect(controller.getSnapshot()).toMatchObject({ text: "", status: "ready", conflict: null });
    expect(store.clears).toEqual([]);
  });

  test("a load waits for a save still in flight to the same scope, so it reads what was saved", async () => {
    class SlowSaveStore extends ScopedDraftStore {
      release: () => void = () => undefined;
      private readonly gate = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      override async save(args: Parameters<ScopedDraftStore["save"]>[0]): Promise<Draft> {
        await this.gate;
        return super.save(args);
      }
    }
    const store = new SlowSaveStore();
    const scope: DraftScope = { kind: "folder", folder: FolderPath.parse("/workspace/app") };
    const writer = new DraftController({ store, scope, timers: idleTimers });
    const reader = new DraftController({ store, scope, timers: idleTimers });
    await writer.load();
    writer.setDraft("saved late", []);

    const saving = writer.flush();
    const loading = reader.load();
    store.release();
    await Promise.all([saving, loading]);

    expect(reader.getSnapshot().text).toBe("saved late");
  });

  test("handOff returns what the scope held, including text typed after the last save, and leaves nothing stored", async () => {
    const store = new ScopedDraftStore();
    const controller = new DraftController({
      store,
      scope: { kind: "folder", folder: FolderPath.parse("/workspace/app") },
      timers: idleTimers,
    });
    await controller.load();
    controller.setDraft("held text", [attachment]);
    await controller.flush();
    controller.setDraft("held text, typed later", [attachment]);

    const held = await controller.handOff();

    expect(held.text).toBe("held text, typed later");
    expect(held.attachments).toEqual([attachment]);
    expect(store.clears).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({ text: "", revision: null, dirty: false });
  });
});

describe("DraftController: unsaved text kept in this tab", () => {
  const folderScope: DraftScope = { kind: "folder", folder: FolderPath.parse("/workspace/app") };
  const quiet = (): void => undefined;
  test("a reload whose stored draft already holds the kept text restores that text once", async () => {
    const store = new FakeDraftStore();
    const storage = new MemoryDraftStorage();
    const first = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await first.load();
    first.setDraft("offline send", []);
    // The save lands, but its answer never reaches the page: the store holds the text at a newer revision than the copy kept.
    await first.flush();
    createDraftBuffer(storage, quiet).write(folderScope, {
      input: { text: "offline send", attachments: [], failedSends: [] },
      baseRevision: null,
      saving: null,
    });

    const reloaded = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await reloaded.load();

    expect(reloaded.getSnapshot().text).toBe("offline send");
  });

  test("a send the chat shows as admitted clears its local copy before the answer comes", async () => {
    const store = new FakeDraftStore();
    const storage = new MemoryDraftStorage();
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await controller.load();
    controller.setDraft("sent text", []);
    let admit: () => void = () => undefined;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const sending = controller.submit(prompt("sent text"), () => admitted);
    // The chat shows the send's message: the local copy goes at once, before the answer that admits the send.
    controller.noteSent();
    const copyAtOnce = createDraftBuffer(storage, quiet).read(folderScope);
    const textAtOnce = controller.getSnapshot().text;
    admit();
    await sending;
    expect(copyAtOnce?.input.text ?? "").toBe("");
    expect(textAtOnce).toBe("");
    expect(controller.getSnapshot()).toMatchObject({ text: "", status: "ready" });
  });

  test("a controller that loads while another send is in flight waits for that send, and restores none of it", async () => {
    const store = new FakeDraftStore();
    const storage = new MemoryDraftStorage();
    const sender = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await sender.load();
    sender.setDraft("sent text", []);
    let admit: () => void = () => undefined;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const sending = sender.submit(prompt("sent text"), () => admitted);
    // A later save for the scope must not hide the send that is still being admitted from a load.
    await sender.flush();
    const next = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    const loading = next.load();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    admit();
    await sending;
    await loading;
    expect(next.getSnapshot().text).toBe("");
  });

  test("a send that clears while the chat's own save of its text is in flight leaves no saved copy for a later load", async () => {
    class SlowSaveStore extends ScopedDraftStore {
      release: () => void = () => undefined;
      private readonly gate = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      override async save(args: Parameters<ScopedDraftStore["save"]>[0]): Promise<Draft> {
        await this.gate;
        return super.save(args);
      }
    }
    const store = new SlowSaveStore();
    const storage = new MemoryDraftStorage();
    const sender = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await sender.load();
    sender.setDraft("sent text", []);
    let admit: () => void = () => undefined;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const sending = sender.submit(prompt("sent text"), () => admitted);
    // The chat's own save of the text starts, as when the chat is left while the send is admitted, and is still in flight.
    const saving = sender.flush();
    admit();
    // The clear runs while the save is still held: its revision is read before the save lands.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    store.release();
    await Promise.all([sending, saving]);
    const reader = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      // A reader with no local copy restores only what the store keeps (the buffer copy would hide a stale store copy).
      buffer: createDraftBuffer(new MemoryDraftStorage(), quiet),
    });
    await reader.load();
    expect(reader.getSnapshot().text).toBe("");
  });

  test("clears the local state before a server clear settles, and keeps the newer empty copy until the clear lands", async () => {
    const store = new GatedClearStore();
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, quiet);
    await store.save({
      scope: folderScope,
      draft: { text: "sent text", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer,
    });
    await controller.load();
    buffer.write(folderScope, {
      input: { text: "sent text", attachments: [], failedSends: [] },
      baseRevision: controller.getSnapshot().revision,
      saving: null,
    });
    const clearing = controller.clearAfterAdmission();
    try {
      await expect.poll(() => store.clearStarted).toBe(true);
      expect(controller.getSnapshot().text).toBe("");
      expect(buffer.read(folderScope)?.input.text ?? "").toBe("");
      expect(buffer.read(folderScope)?.saving).toBeNull();
      expect(JSON.stringify(buffer.read(folderScope))).not.toContain("sent text");
    } finally {
      // A failure must not leave the clear held: its write would block every later test on this scope.
      if (store.clearStarted) store.release();
    }
    await clearing;
    expect(buffer.read(folderScope)).toBeNull();
  });

  test("a server clear that rejects leaves the box empty, and the buffer keeps the newer empty copy", async () => {
    const store = new GatedClearStore();
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, quiet);
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer,
    });
    await controller.load();
    controller.setDraft("sent text", []);
    await controller.flush();
    const clearing = controller.clearAfterAdmission("sent text");
    await expect.poll(() => store.clearStarted).toBe(true);
    store.reject(new AppFailure({ code: "unavailable", message: "clear failed", retryable: true }));
    await clearing;
    expect(controller.getSnapshot().text).toBe("");
    expect(buffer.read(folderScope)?.input.text).toBe("");
    expect(buffer.read(folderScope)?.saving).toBeNull();
    expect(JSON.stringify(buffer.read(folderScope))).not.toContain("sent text");
  });

  test("text typed after a failed clear is kept, and the sent text does not come back", async () => {
    const store = new GatedClearStore();
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, quiet);
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer,
    });
    await controller.load();
    controller.setDraft("sent text", []);
    await controller.flush();
    const clearing = controller.clearAfterAdmission("sent text");
    await expect.poll(() => store.clearStarted).toBe(true);
    controller.setDraft("typed after", []);
    store.reject(new AppFailure({ code: "unavailable", message: "clear failed", retryable: true }));
    await clearing;
    expect(controller.getSnapshot().text).toBe("typed after");
    expect(buffer.read(folderScope)?.input.text).toBe("typed after");
  });

  test("a server clear that reports a conflict leaves the box empty, and the sent text does not come back", async () => {
    const store = new GatedClearStore("notCleared");
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, quiet);
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer,
    });
    await controller.load();
    controller.setDraft("sent text", []);
    await controller.flush();
    store.gateGet();
    const clearing = controller.clearAfterAdmission("sent text");
    await expect.poll(() => store.clearStarted).toBe(true);
    store.release();
    await expect.poll(() => store.getStarted).toBe(true);
    expect(buffer.read(folderScope)?.input.text).toBe("");
    store.releaseGet();
    await clearing;
    expect(controller.getSnapshot().text).toBe("");
    expect(buffer.read(folderScope)?.input.text).toBe("");
    expect(controller.getSnapshot().status).toBe("conflict");
  });
  test("a server clear conflict leaves the box empty, without throwing", async () => {
    const store = new GatedClearStore();
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, quiet);
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer,
    });
    await controller.load();
    controller.setDraft("sent text", []);
    await controller.flush();
    store.gateGet();
    const clearing = controller.clearAfterAdmission("sent text");
    await expect.poll(() => store.clearStarted).toBe(true);
    store.reject(new AppFailure({ code: "conflict", message: "changed", retryable: true }));
    await expect.poll(() => store.getStarted).toBe(true);
    expect(buffer.read(folderScope)?.input.text).toBe("");
    store.releaseGet();
    await clearing;
    expect(controller.getSnapshot().text).toBe("");
    expect(buffer.read(folderScope)?.input.text).toBe("");
    expect(controller.getSnapshot().status).toBe("conflict");
  });

  test("typed text is kept in the buffer until the server saves it, and the save clears it", async () => {
    const store = new ScopedDraftStore();
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer,
    });
    await controller.load();

    controller.setDraft("typed, not saved yet", []);
    expect(buffer.read(folderScope)?.input.text).toBe("typed, not saved yet");

    await controller.flush();
    expect(buffer.read(folderScope)).toBeNull();
  });

  test("a sent draft leaves nothing in the buffer", async () => {
    const store = new ScopedDraftStore();
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer,
    });
    await controller.load();
    controller.setDraft("sent text", []);

    await controller.submit(prompt("sent text"), async () => undefined);

    expect(buffer.read(folderScope)).toBeNull();
  });
  test("an admitted send clears its scope without waiting on its own tracked write", async () => {
    const store = new ScopedDraftStore();
    await store.save({
      scope: folderScope,
      draft: { text: "old draft", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const controller = new DraftController({ store, scope: folderScope, timers: idleTimers });
    await controller.load();
    controller.setDraft("sent text", []);

    const submitted = controller.submit(prompt("sent text"), async () => undefined);
    await expect.poll(() => store.clears.length).toBe(1);
    await submitted;

    await expect.poll(() => store.text(folderScope)).toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({ text: "", dirty: false });
  });

  test("a send settles once its prompt is admitted, and its clear finishes after that", async () => {
    const store = new GatedClearStore();
    const controller = new DraftController({ store, scope: folderScope, timers: idleTimers });
    await controller.load();
    controller.setDraft("sent text", []);
    await controller.flush();
    let settled = false;
    const sending = controller
      .submit(prompt("sent text"), async () => undefined)
      .then(() => {
        settled = true;
      });
    try {
      await expect.poll(() => store.clearStarted).toBe(true);
      await expect.poll(() => settled).toBe(true);
    } finally {
      // A failure must not leave the clear held: its write would block every later test on this scope.
      if (store.clearStarted) store.release();
    }
    await sending;
    expect(store.text(folderScope)).toBeUndefined();
  });

  test("a read that begins during an admission waits for the admitted send's clear, and restores none of the sent text", async () => {
    const store = new GatedClearStore();
    const storage = new MemoryDraftStorage();
    const sender = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await sender.load();
    sender.setDraft("sent text", []);
    await sender.flush();
    const admission = Promise.withResolvers<void>();
    const sending = sender.submit(prompt("sent text"), () => admission.promise);
    const reader = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    let loaded = false;
    const loading = reader.load().then(() => {
      loaded = true;
    });
    admission.resolve();
    try {
      await expect.poll(() => store.clearStarted).toBe(true);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(loaded).toBe(false);
    } finally {
      if (store.clearStarted) store.release();
    }
    await Promise.all([sending, loading]);
    expect(reader.getSnapshot().text).toBe("");
  });

  /** A store whose first server clear fails, as a dropped connection does; the clears after it succeed. */
  class ClearFailsOnce extends ScopedDraftStore {
    serverClearCalls = 0;
    override async clear(args: Parameters<ScopedDraftStore["clear"]>[0]) {
      this.serverClearCalls += 1;
      if (this.serverClearCalls === 1) {
        throw new AppFailure({ code: "unavailable", message: "clear failed", retryable: true });
      }
      return super.clear(args);
    }
  }

  test("a clear that fails after the send is admitted leaves the box empty, records no failed send, and is retried", async () => {
    const store = new ClearFailsOnce();
    await store.save({
      scope: folderScope,
      draft: { text: "sent text", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const timers = new FakeTimers();
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers,
      buffer: createDraftBuffer(new MemoryDraftStorage(), quiet),
    });
    await controller.load();
    await controller.submit(prompt("sent text"), async () => undefined);
    expect(controller.getSnapshot()).toMatchObject({ text: "", failedSends: [] });
    await expect.poll(() => store.serverClearCalls).toBe(1);
    await timers.runAll();
    await expect.poll(() => store.text(folderScope)).toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({ text: "", failedSends: [], status: "ready" });
  });

  test("a reload before the clear's retry succeeds shows an empty box, not the sent text", async () => {
    const store = new ClearFailsOnce();
    await store.save({
      scope: folderScope,
      draft: { text: "sent text", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    const storage = new MemoryDraftStorage();
    const first = new DraftController({
      store,
      scope: folderScope,
      timers: new FakeTimers(),
      buffer: createDraftBuffer(storage, quiet),
    });
    await first.load();
    await first.submit(prompt("sent text"), async () => undefined);
    await expect.poll(() => store.serverClearCalls).toBe(1);
    const reloaded = new DraftController({
      store,
      scope: folderScope,
      timers: new FakeTimers(),
      buffer: createDraftBuffer(storage, quiet),
    });
    await reloaded.load();
    expect(reloaded.getSnapshot().text).toBe("");
  });

  test("a new controller restores text typed before the app stopped, when the server draft has not changed", async () => {
    const store = new ScopedDraftStore();
    const storage = new MemoryDraftStorage();
    const before = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await before.load();
    before.setDraft("typed before the restart", [attachment]);
    // The app stops before the autosave, so `before` is never flushed.

    const after = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await after.load();

    expect(after.getSnapshot()).toMatchObject({
      text: "typed before the restart",
      attachments: [attachment],
      dirty: true,
      status: "ready",
    });
    await after.flush();
    expect(store.text(folderScope)).toBe("typed before the restart");
  });

  test("when another tab saved the draft after this text was typed, both texts are kept and saved over the stored revision", async () => {
    const store = new ScopedDraftStore();
    const storage = new MemoryDraftStorage();
    const before = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await before.load();
    before.setDraft("typed here", []);
    await store.save({
      scope: folderScope,
      draft: { text: "saved elsewhere", attachments: [], failedSends: [] },
      expectedRevision: null,
    });

    const after = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await after.load();
    await after.flush();

    expect(store.text(folderScope)).toBe("saved elsewhere\n\ntyped here");
  });

  test("text typed while the restored text loads comes after it, and nothing is lost", async () => {
    const store = new ScopedDraftStore();
    const storage = new MemoryDraftStorage();
    const before = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await before.load();
    before.setDraft("typed before", []);

    const after = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    const loading = after.load();
    after.setDraft("typed while loading", []);
    await loading;

    expect(after.getSnapshot().text).toBe("typed before\n\ntyped while loading");
  });

  test("a save that finishes after more text was typed leaves that text unsaved, so the next save stores it", async () => {
    class GatedSaveStore extends ScopedDraftStore {
      private readonly gate = Promise.withResolvers<void>();
      release(): void {
        this.gate.resolve();
      }
      override async save(args: Parameters<ScopedDraftStore["save"]>[0]): Promise<Draft> {
        await this.gate.promise;
        return super.save(args);
      }
    }
    const store = new GatedSaveStore();
    const controller = new DraftController({ store, scope: folderScope, timers: idleTimers });
    await controller.load();
    controller.setDraft("first", []);

    const saving = controller.flush();
    controller.setDraft("first, then more", []);
    store.release();
    await saving;

    expect(controller.getSnapshot()).toMatchObject({ text: "first, then more", dirty: true });
    await controller.flush();
    expect(store.text(folderScope)).toBe("first, then more");
  });
  test("waits for an autosave before reading the revision to clear an admitted draft", async () => {
    class GatedSaveStore extends ScopedDraftStore {
      private readonly gate = Promise.withResolvers<void>();
      release(): void {
        this.gate.resolve();
      }
      override async save(args: Parameters<ScopedDraftStore["save"]>[0]): Promise<Draft> {
        await this.gate.promise;
        return super.save(args);
      }
    }
    const store = new GatedSaveStore();
    const controller = new DraftController({ store, scope: folderScope, timers: idleTimers });
    await controller.load();
    controller.setDraft("sent text", []);
    const saving = controller.flush();
    const clearing = controller.clearAfterAdmission("sent text");
    await Promise.resolve();
    expect(store.clears).toEqual([]);
    store.release();
    await Promise.all([saving, clearing]);
    expect(store.clears).toEqual(["folder:/workspace/app"]);
  });

  test("a failed save keeps the text in the buffer, so it is still there after the app stops", async () => {
    class DownStore extends ScopedDraftStore {
      override async save(): Promise<Draft> {
        throw new AppFailure({
          code: "unavailable",
          message: "The store is down",
          retryable: true,
        });
      }
    }
    const storage = new MemoryDraftStorage();
    const controller = new DraftController({
      store: new DownStore(),
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await controller.load();
    controller.setDraft("kept when the save fails", []);

    await expect(controller.flush()).rejects.toBeInstanceOf(AppFailure);
    expect(createDraftBuffer(storage, quiet).read(folderScope)?.input.text).toBe(
      "kept when the save fails",
    );
  });

  test("loads started together, as StrictMode's effects start them, restore the kept text once", async () => {
    const store = new ScopedDraftStore();
    const storage = new MemoryDraftStorage();
    const before = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await before.load();
    before.setDraft("typed once", []);

    const after = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await Promise.all([after.load(), after.load()]);

    expect(after.getSnapshot().text).toBe("typed once");
  });

  /** A store whose save lands on the server while its answer never reaches the page, as when the connection closes. */
  class LandingStore extends ScopedDraftStore {
    override async save(args: Parameters<ScopedDraftStore["save"]>[0]): Promise<Draft> {
      await super.save(args);
      throw new AppFailure({
        code: "unavailable",
        message: "The connection closed",
        retryable: true,
      });
    }
  }

  test("a save that landed without its answer is not added to the stored text again", async () => {
    const store = new LandingStore();
    const storage = new MemoryDraftStorage();
    const before = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await before.load();
    before.setDraft("typed once", []);
    await expect(before.flush()).rejects.toBeInstanceOf(AppFailure);
    expect(store.text(folderScope)).toBe("typed once");

    const after = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await after.load();

    expect(after.getSnapshot()).toMatchObject({ text: "typed once", dirty: true });
  });

  test("text typed after a save that landed without its answer comes after nothing it already holds", async () => {
    const store = new LandingStore();
    const storage = new MemoryDraftStorage();
    const before = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await before.load();
    before.setDraft("typed once", []);
    await expect(before.flush()).rejects.toBeInstanceOf(AppFailure);
    before.setDraft("typed once, then more", []);

    const after = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await after.load();

    expect(after.getSnapshot().text).toBe("typed once, then more");
  });

  test("a second load of a controller that already restored the kept text keeps that text once", async () => {
    const store = new ScopedDraftStore();
    const storage = new MemoryDraftStorage();
    const before = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await before.load();
    before.setDraft("typed once", []);

    // The composer loads its controller again when the controller it shows changes, after the first load restored it.
    const after = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await after.load();
    await after.load();

    expect(after.getSnapshot().text).toBe("typed once");
  });

  /** Lets every promise continuation that is ready run, without any wall-clock wait. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  }

  /** A store whose read waits until `release` runs, so the test types while the draft is loading. */
  function gatedStore(): { store: FakeDraftStore; release: () => void } {
    const store = new FakeDraftStore();
    const gate = Promise.withResolvers<void>();
    const read = store.get.bind(store);
    store.get = async () => {
      await gate.promise;
      return read();
    };
    return { store, release: () => gate.resolve() };
  }

  const OLDER = "older unsent text the server never got";

  test("a key typed while the draft loads goes after the older text in the local copy, so a kill at that moment loses nothing", async () => {
    const storage = new MemoryDraftStorage();
    createDraftBuffer(storage, quiet).write(folderScope, {
      input: { text: OLDER, attachments: [], failedSends: [] },
      baseRevision: null,
      saving: null,
    });
    const { store, release } = gatedStore();
    const controller = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    const loading = controller.load();
    await settle();

    controller.setDraft("n", []);

    expect(createDraftBuffer(storage, quiet).read(folderScope)?.input.text).toBe(`${OLDER}\n\nn`);
    release();
    await loading;
    expect(controller.getSnapshot().text).toBe(`${OLDER}\n\nn`);
  });

  test("a page killed while the draft loads and a key was typed reopens with the older text and the key", async () => {
    const storage = new MemoryDraftStorage();
    createDraftBuffer(storage, quiet).write(folderScope, {
      input: { text: OLDER, attachments: [], failedSends: [] },
      baseRevision: null,
      saving: null,
    });
    const { store } = gatedStore();
    const killed = new DraftController({
      store,
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    void killed.load();
    await settle();
    killed.setDraft("n", []);

    const reopened = new DraftController({
      store: new FakeDraftStore(),
      scope: folderScope,
      timers: idleTimers,
      buffer: createDraftBuffer(storage, quiet),
    });
    await reopened.load();

    expect(reopened.getSnapshot().text).toBe(`${OLDER}\n\nn`);
  });

  test("a save that landed without its answer, tried again over its own revision, is not a conflict", async () => {
    const store = new LandingStore();
    const controller = new DraftController({ store, scope: folderScope, timers: idleTimers });
    await controller.load();
    controller.setDraft("typed once", []);
    await expect(controller.flush()).rejects.toBeInstanceOf(AppFailure);

    await controller.flush();

    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      conflict: null,
      dirty: false,
    });
    expect(controller.getSnapshot().revision).not.toBeNull();
    expect(store.text(folderScope)).toBe("typed once");
  });
});

describe("DraftController: a failed step and a conflict", () => {
  test("a failed load shows its reason, and retry loads the stored draft once the store answers", async () => {
    class FlakyGetStore extends FakeDraftStore {
      failNextGet = true;
      override async get(): Promise<{ draft: Draft | null }> {
        if (this.failNextGet) {
          this.failNextGet = false;
          throw new AppFailure({
            code: "unavailable",
            message: "The store is down",
            retryable: true,
          });
        }
        return super.get();
      }
    }
    const store = new FlakyGetStore();
    store.draft = {
      scope,
      text: "stored text",
      attachments: [],
      failedSends: [],
      revision: "r0" as Revision,
      updatedAt: new Date(1).toISOString(),
    };
    const controller = new DraftController({ store, scope, timers: new FakeTimers() });

    await expect(controller.load()).rejects.toMatchObject({
      appError: { message: "The store is down" },
    });
    expect(controller.getSnapshot()).toMatchObject({ status: "error" });

    await controller.retry();
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      text: "stored text",
      error: null,
    });
  });

  test("a failed save shows its reason, and retry saves the text again", async () => {
    class FlakySaveStore extends FakeDraftStore {
      failNextSave = true;
      override async save(args: Parameters<FakeDraftStore["save"]>[0]): Promise<Draft> {
        if (this.failNextSave) {
          this.failNextSave = false;
          throw new AppFailure({ code: "internal", message: "Disk full", retryable: true });
        }
        return super.save(args);
      }
    }
    const store = new FlakySaveStore();
    const controller = new DraftController({ store, scope, timers: new FakeTimers() });
    await controller.load();
    controller.setDraft("kept text", []);

    await expect(controller.flush()).rejects.toMatchObject({ appError: { message: "Disk full" } });
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      dirty: true,
      text: "kept text",
    });

    await controller.retry();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", dirty: false, error: null });
    expect(store.draft?.text).toBe("kept text");
  });
  test("a failed save retries itself after the store becomes available", async () => {
    class FlakySaveStore extends FakeDraftStore {
      failNextSave = true;
      override async save(args: Parameters<FakeDraftStore["save"]>[0]): Promise<Draft> {
        if (this.failNextSave) {
          this.failNextSave = false;
          throw new AppFailure({ code: "internal", message: "Disk full", retryable: true });
        }
        return super.save(args);
      }
    }
    const store = new FlakySaveStore();
    const timers = new FakeTimers();
    const controller = new DraftController({ store, scope, timers });
    await controller.load();
    controller.setDraft("retry this text", []);

    await expect(controller.flush()).rejects.toMatchObject({ appError: { message: "Disk full" } });
    await timers.runAll();
    expect(store.draft?.text).toBe("retry this text");
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", dirty: false });
  });

  test("a clear that conflicts while a draft moves out waits for a choice, not a dead-end error", async () => {
    class ConflictOnClear extends FakeDraftStore {
      override async clear(): Promise<{ cleared: boolean; revision: Revision | null }> {
        return { cleared: false, revision: null };
      }
    }
    const store = new ConflictOnClear();
    store.draft = {
      scope,
      text: "remote text",
      attachments: [],
      failedSends: [],
      revision: "remote-r" as Revision,
      updatedAt: new Date(2).toISOString(),
    };
    const controller = new DraftController({ store, scope, timers: new FakeTimers() });
    await controller.load();
    controller.setDraft("local text", []);

    await expect(controller.handOff()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(controller.getSnapshot()).toMatchObject({
      status: "conflict",
      conflict: { local: { text: "local text" }, remote: { text: "remote text" } },
    });
  });
});

describe("DraftController: an earlier draft that text typed before it loaded would replace", () => {
  const chat: DraftScope = { kind: "thread", threadId: "thread-replaced" as never };
  const quiet = (): void => undefined;

  function savedDraft(text: string, attachments: readonly AttachmentRef[] = []): Draft {
    return {
      scope: chat,
      text,
      attachments: [...attachments],
      failedSends: [],
      revision: "r0" as Revision,
      updatedAt: new Date(1).toISOString(),
    };
  }

  /** A store whose read of the saved draft waits until `release` runs, so the test types while the draft is loading. */
  function heldStore(draft: Draft): { store: FakeDraftStore; release: () => void } {
    const store = new FakeDraftStore();
    store.draft = draft;
    const gate = Promise.withResolvers<void>();
    const read = store.get.bind(store);
    store.get = async () => {
      await gate.promise;
      return read();
    };
    return { store, release: () => gate.resolve() };
  }

  /** Opens the chat whose saved draft is `earlier`, types `typed` before that draft has loaded, then lets it load. */
  async function typeBeforeLoad(
    earlier: Draft,
    typed: string,
    buffer: DraftBuffer,
  ): Promise<{ store: FakeDraftStore; controller: DraftController }> {
    const { store, release } = heldStore(earlier);
    const controller = new DraftController({
      store,
      scope: chat,
      timers: new FakeTimers(),
      buffer,
    });
    const loading = controller.load();
    controller.setDraft(typed, []);
    release();
    await loading;
    return { store, controller };
  }

  test("keeps the earlier draft recoverable, and saves the typed text, which still wins", async () => {
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { store, controller } = await typeBeforeLoad(
      savedDraft("earlier draft"),
      "typed first",
      buffer,
    );

    expect(controller.getSnapshot()).toMatchObject({
      text: "typed first",
      replaced: { text: "earlier draft", attachments: [], failedSends: [] },
    });
    expect(buffer.readReplaced(chat)).toEqual({
      text: "earlier draft",
      attachments: [],
      failedSends: [],
    });
    await controller.flush();
    expect(store.draft?.text).toBe("typed first");
  });

  test("restoring the earlier draft puts it in front of the text typed since, and saves both", async () => {
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { store, controller } = await typeBeforeLoad(
      savedDraft("earlier draft"),
      "typed first",
      buffer,
    );

    controller.resolveReplaced("restore");

    expect(controller.getSnapshot()).toMatchObject({
      text: "earlier draft\n\ntyped first",
      dirty: true,
      replaced: null,
    });
    expect(buffer.readReplaced(chat)).toBeNull();
    await controller.flush();
    expect(store.draft?.text).toBe("earlier draft\n\ntyped first");
  });

  test("dismissing the earlier draft forgets it, and only the typed text is saved", async () => {
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { store, controller } = await typeBeforeLoad(
      savedDraft("earlier draft"),
      "typed first",
      buffer,
    );

    controller.resolveReplaced("dismiss");

    expect(controller.getSnapshot().replaced).toBeNull();
    expect(buffer.readReplaced(chat)).toBeNull();
    await controller.flush();
    expect(store.draft?.text).toBe("typed first");
  });

  test("a chat opened again in the same session offers the earlier draft until it is restored or dismissed", async () => {
    const storage = new MemoryDraftStorage();
    const { store, controller } = await typeBeforeLoad(
      savedDraft("earlier draft"),
      "typed first",
      createDraftBuffer(storage, quiet),
    );
    await controller.flush();

    const later = new DraftController({
      store,
      scope: chat,
      timers: new FakeTimers(),
      buffer: createDraftBuffer(storage, quiet),
    });
    await later.load();

    expect(later.getSnapshot()).toMatchObject({
      text: "typed first",
      dirty: false,
      replaced: { text: "earlier draft" },
    });
  });

  test("an earlier draft that only had attachments is kept too", async () => {
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { controller } = await typeBeforeLoad(
      savedDraft("", [attachment]),
      "typed first",
      buffer,
    );

    expect(controller.getSnapshot().replaced).toMatchObject({
      text: "",
      attachments: [attachment],
    });
  });

  test("a stored draft the typed text already equals is not kept as an earlier draft", async () => {
    const buffer = createDraftBuffer(new MemoryDraftStorage(), quiet);
    const { controller } = await typeBeforeLoad(savedDraft("same text"), "same text", buffer);

    expect(controller.getSnapshot().replaced).toBeNull();
    expect(buffer.readReplaced(chat)).toBeNull();
  });

  test("a load after a move adopted text keeps the draft the controller loaded as the text, not as an earlier draft", async () => {
    const store = new FakeDraftStore();
    store.draft = savedDraft("loaded draft");
    const controller = new DraftController({ store, scope: chat, timers: new FakeTimers() });
    await controller.load();
    controller.adopt({ text: "moved text", attachments: [], failedSends: [] });

    await controller.load();

    expect(controller.getSnapshot()).toMatchObject({
      text: "loaded draft\n\nmoved text",
      replaced: null,
    });
  });
});
