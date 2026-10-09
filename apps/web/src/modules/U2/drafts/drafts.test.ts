import type { AttachmentRef, Draft, DraftChanged, DraftScope, Revision } from "@omp-app/contracts";
import { AppFailure, FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { PromptIntent } from "../../R0/runtime/runtime";
import {
  DraftController,
  type DraftLifecycleTarget,
  type DraftStoreAdapter,
  type DraftTimer,
} from "./drafts";
import { ScopedDraftStore } from "./test-support";

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
