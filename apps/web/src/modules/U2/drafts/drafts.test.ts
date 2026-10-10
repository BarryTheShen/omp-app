import type { AttachmentRef, Draft, DraftChanged, DraftScope, Revision } from "@omp-app/contracts";
import { AppFailure, FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { createDraftBuffer, type DraftBufferStorage } from "./draft-buffer";
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
    const store = new FakeDraftStore();
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
    const controller = new DraftController({ store, scope, timers });
    const loading = controller.load();
    controller.setDraft("typed first", []);
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
    expect(store.clearCount).toBe(1);
    expect(controller.getSnapshot().text).toBe("");
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
