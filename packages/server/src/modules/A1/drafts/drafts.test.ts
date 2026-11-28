import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppFailure, type DraftInput } from "@omp-app/contracts";
import { hashContent } from "../fs";
import { DraftConflict, DraftStoreService } from "./store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-drafts-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Polls until a real watcher event has made the condition true, so each wait ends with the event, not a duration. */
async function waitUntil(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher's event");
    await Bun.sleep(10);
  }
}

function attachment() {
  return {
    id: "attachment-1",
    name: "notes.txt",
    mediaType: "text/plain",
    sizeBytes: 12,
    uri: "files/notes.txt",
  };
}

function draftInput(text: string, failedSends: DraftInput["failedSends"] = []): DraftInput {
  return { text, attachments: [attachment()], failedSends };
}

async function expectAppFailure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
    throw new Error("Expected an AppFailure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    return error as AppFailure;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DraftStoreService", () => {
  test("stores per-thread and per-folder drafts with attachment references", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const store = new DraftStoreService({ appDataDir: join(root, "app") });
    expect((await store.get({ scope: { kind: "thread", threadId: "thread-1" } })).draft).toBeNull();

    const thread = await store.save({
      scope: { kind: "thread", threadId: "thread-1" },
      draft: draftInput("thread text"),
      expectedRevision: null,
    });
    expect(thread).toMatchObject({
      scope: { kind: "thread", threadId: "thread-1" },
      text: "thread text",
      attachments: [{ id: "attachment-1", sizeBytes: 12 }],
    });
    expect(thread.revision).toHaveLength(64);

    const folder = await store.save({
      scope: { kind: "folder", folder: project },
      draft: draftInput("new chat"),
      expectedRevision: null,
    });
    expect((await store.get({ scope: { kind: "folder", folder: project } })).draft).toMatchObject({
      text: "new chat",
      revision: folder.revision,
    });
    expect(
      (await store.get({ scope: { kind: "thread", threadId: "thread-1" } })).draft,
    ).toMatchObject({
      text: "thread text",
    });
    expect(await store.referencedAttachments()).toEqual({ refs: [attachment()], complete: true });
    store.dispose();
  });

  test("keeps a Workbench box's text apart from a chat's, also after a restart, and refuses a key of no box", async () => {
    const root = await temporaryDirectory();
    const appDataDir = join(root, "app");
    const store = new DraftStoreService({ appDataDir });
    const reply = { kind: "work", key: "reply:mwyf36n5yns0a0" } as const;
    const saved = await store.save({
      scope: reply,
      draft: { text: "half an answer", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    await store.save({
      scope: { kind: "thread", threadId: "mwyf36n5yns0a0" },
      draft: { text: "the chat's own", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    store.dispose();
    const again = new DraftStoreService({ appDataDir });
    expect((await again.get({ scope: reply })).draft).toMatchObject({
      text: "half an answer",
      revision: saved.revision,
    });
    expect(
      (await again.get({ scope: { kind: "work", key: "compose:mwyf36n5yns0a0" } })).draft,
    ).toBeNull();
    await expectAppFailure(again.get({ scope: { kind: "work", key: "../../escape" } }));
    again.dispose();
  });

  test("prunes failed-send history to the newest 20 entries per scope", async () => {
    const root = await temporaryDirectory();
    const store = new DraftStoreService({ appDataDir: join(root, "app") });
    const failedSends = Array.from({ length: 21 }, (_, index) => ({
      attemptedAt: `2026-10-04T00:00:${String(index).padStart(2, "0")}Z`,
      text: `failed-${index}`,
      attachments: [{ ...attachment(), id: "failed-attachment" }],
      reason: `reason-${index}`,
    }));
    const saved = await store.save({
      scope: { kind: "thread", threadId: "history" },
      draft: draftInput("keep me", failedSends),
      expectedRevision: null,
    });
    expect(saved.failedSends).toHaveLength(20);
    expect(saved.failedSends[0]?.text).toBe("failed-1");
    const loaded = (await store.get({ scope: { kind: "thread", threadId: "history" } })).draft;
    expect(loaded?.failedSends).toHaveLength(20);
    expect((await store.referencedAttachments()).refs.map((ref) => ref.id)).toEqual([
      "attachment-1",
      "failed-attachment",
    ]);
    expect(loaded?.failedSends.at(-1)?.text).toBe("failed-20");
    store.dispose();
  });

  test("uses CAS revisions so a stale concurrent save loses with the current revision", async () => {
    const root = await temporaryDirectory();
    const store = new DraftStoreService({ appDataDir: join(root, "app") });
    const writes = await Promise.allSettled([
      store.save({
        scope: { kind: "thread", threadId: "race" },
        draft: draftInput("first"),
        expectedRevision: null,
      }),
      store.save({
        scope: { kind: "thread", threadId: "race" },
        draft: draftInput("second"),
        expectedRevision: null,
      }),
    ]);
    const winners = writes.filter((result) => result.status === "fulfilled");
    const losers = writes.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0];
    const loser = losers[0];
    if (winner?.status !== "fulfilled" || loser?.status !== "rejected") {
      throw new Error("Expected one winning and one losing save.");
    }
    expect(loser.reason).toBeInstanceOf(DraftConflict);
    expect((loser.reason as DraftConflict).currentRevision).toBe(winner.value.revision);
    expect((await store.get({ scope: { kind: "thread", threadId: "race" } })).draft?.revision).toBe(
      winner.value.revision,
    );
    store.dispose();
  });

  test("clears only explicitly, reports stale clear conflicts, and allows a fresh save after clear", async () => {
    const root = await temporaryDirectory();
    const store = new DraftStoreService({ appDataDir: join(root, "app") });
    const saved = await store.save({
      scope: { kind: "thread", threadId: "clear" },
      draft: draftInput("before clear"),
      expectedRevision: null,
    });
    const stale = await expectAppFailure(
      store.clear({
        scope: { kind: "thread", threadId: "clear" },
        expectedRevision: "stale-revision",
      }),
    );
    expect(stale).toBeInstanceOf(DraftConflict);
    expect((stale as DraftConflict).currentRevision).toBe(saved.revision);

    expect(
      await store.clear({
        scope: { kind: "thread", threadId: "clear" },
        expectedRevision: saved.revision,
      }),
    ).toEqual({ cleared: true, revision: null });
    expect((await store.get({ scope: { kind: "thread", threadId: "clear" } })).draft).toBeNull();
    expect(
      await store.clear({
        scope: { kind: "thread", threadId: "clear" },
        expectedRevision: null,
      }),
    ).toEqual({ cleared: false, revision: null });

    const afterClear = await store.save({
      scope: { kind: "thread", threadId: "clear" },
      draft: draftInput("after clear"),
      expectedRevision: null,
    });
    expect(afterClear.text).toBe("after clear");
    store.dispose();
  });

  test("rejects inline attachment binaries and malformed draft files without crashing", async () => {
    const root = await temporaryDirectory();
    const app = join(root, "app");
    const errors: AppFailure[] = [];
    const store = new DraftStoreService({
      appDataDir: app,
      onError: (error) => errors.push(error),
    });
    const inlineDraft: unknown = {
      text: "not binary",
      attachments: [{ ...attachment(), data: "raw-bytes" }],
      failedSends: [],
    };
    const inline = await expectAppFailure(
      store.save({
        scope: { kind: "thread", threadId: "inline" },
        draft: inlineDraft as DraftInput,
        expectedRevision: null,
      }),
    );
    expect(inline.appError.code).toBe("invalid_args");
    const path = join(store.draftsDir, "threads", `${hashContent("malformed")}.json`);
    await mkdir(join(store.draftsDir, "threads"), { recursive: true });
    await writeFile(path, "{not-json", "utf8");
    const malformed = await expectAppFailure(
      store.get({ scope: { kind: "thread", threadId: "malformed" } }),
    );
    expect(malformed.appError.code).toBe("invalid_args");
    expect(errors).toHaveLength(0);
    store.dispose();
  });

  test("an unreadable draft file is named in a report and skipped; other pictures still count", async () => {
    const root = await temporaryDirectory();
    const errors: AppFailure[] = [];
    const store = new DraftStoreService({
      appDataDir: join(root, "app"),
      onError: (error) => errors.push(error),
    });
    await store.save({
      scope: { kind: "thread", threadId: "readable" },
      draft: draftInput("kept"),
      expectedRevision: null,
    });
    const threads = join(store.draftsDir, "threads");
    const folders = join(store.draftsDir, "folders");
    await mkdir(threads, { recursive: true });
    await mkdir(folders, { recursive: true });
    const empty = join(threads, "empty.json");
    const notJson = join(threads, "not-json.json");
    const newerVersion = join(folders, "newer.json");
    await writeFile(empty, "", "utf8");
    await writeFile(notJson, "{not-json", "utf8");
    const newer = { version: 2, kind: "draft", text: "", attachments: [], failedSends: [] };
    await writeFile(newerVersion, `${JSON.stringify(newer)}\n`, "utf8");

    expect(await store.referencedAttachments()).toEqual({ refs: [attachment()], complete: false });
    const messages = errors.map((error) => error.appError.message);
    expect(messages).toHaveLength(3);
    expect(messages).toContain(
      `Cannot read draft file ${empty}: Draft file contains malformed JSON.`,
    );
    expect(messages).toContain(
      `Cannot read draft file ${notJson}: Draft file contains malformed JSON.`,
    );
    expect(messages).toContain(
      `Cannot read draft file ${newerVersion}: Draft file has an unsupported format.`,
    );
    // The unreadable files are left as they are, and the readable draft still loads.
    expect(await readFile(empty, "utf8")).toBe("");
    const loaded = await store.get({ scope: { kind: "thread", threadId: "readable" } });
    expect(loaded.draft?.text).toBe("kept");
    store.dispose();
  });

  test("hasThreadDraft says at once whether a thread holds a draft with something in it", async () => {
    const root = await temporaryDirectory();
    const store = new DraftStoreService({ appDataDir: join(root, "app") });
    const scope = { kind: "thread" as const, threadId: "held" };
    expect(store.hasThreadDraft("held")).toBe(false);

    const saved = await store.save({
      scope,
      draft: draftInput("unsent words"),
      expectedRevision: null,
    });
    expect(store.hasThreadDraft("held")).toBe(true);
    expect(store.hasThreadDraft("another")).toBe(false);

    // Nothing in it any more: no text, no file, no failed send.
    const emptied = await store.save({
      scope,
      draft: { text: "  ", attachments: [], failedSends: [] },
      expectedRevision: saved.revision,
    });
    expect(store.hasThreadDraft("held")).toBe(false);
    // An attached file alone is something.
    await store.save({
      scope,
      draft: { text: "", attachments: [attachment()], failedSends: [] },
      expectedRevision: emptied.revision,
    });
    expect(store.hasThreadDraft("held")).toBe(true);
    const current = (await store.get({ scope })).draft;
    await store.clear({ scope, expectedRevision: current?.revision ?? null });
    expect(store.hasThreadDraft("held")).toBe(false);

    // A file that cannot be read counts as a draft: nothing is lost on a doubt.
    await mkdir(join(store.draftsDir, "threads"), { recursive: true });
    await writeFile(
      join(store.draftsDir, "threads", `${hashContent("broken")}.json`),
      "{no",
      "utf8",
    );
    expect(store.hasThreadDraft("broken")).toBe(true);
    store.dispose();
  });

  test("announces each change once: its own saves and clears, and a change made outside the app", async () => {
    const root = await temporaryDirectory();
    const app = join(root, "app");
    const scope = { kind: "thread" as const, threadId: "events" };
    const events: { draft: { text: string; revision: string } | null }[] = [];
    const others: unknown[] = [];
    const store = new DraftStoreService({ appDataDir: app });
    const unsubscribe = store.subscribe(scope, (change) => {
      events.push(change as (typeof events)[number]);
    });
    const unsubscribeOther = store.subscribe({ kind: "thread", threadId: "other" }, (change) => {
      others.push(change);
    });
    // Another window open on the chat hears a save made here, with its revision (the file watcher skips own writes).
    const saved = await store.save({ scope, draft: draftInput("own"), expectedRevision: null });
    expect(events).toHaveLength(1);
    expect(events[0]?.draft).toMatchObject({ text: "own", revision: saved.revision });

    // An external write is waited for by the event it makes; a second event for our own save would show up as an extra.
    const path = join(store.draftsDir, "threads", `${hashContent("events")}.json`);
    const writeExternal = (text: string) =>
      writeFile(
        path,
        `${JSON.stringify({
          version: 1,
          kind: "draft",
          scope,
          text,
          attachments: [attachment()],
          failedSends: [],
          updatedAt: "2026-10-04T00:00:00.000Z",
        })}\n`,
        "utf8",
      );
    await writeExternal("external");
    await waitUntil(() => events.length === 2);
    expect(events[1]?.draft?.text).toBe("external");

    await store.clear({
      scope,
      expectedRevision: (await store.get({ scope })).draft?.revision ?? saved.revision,
    });
    expect(events).toHaveLength(3);
    expect(events[2]?.draft).toBeNull();
    await writeExternal("after clear");
    await waitUntil(() => events.length === 4);
    expect(events[3]?.draft?.text).toBe("after clear");
    // Another chat's subscriber hears none of it.
    expect(others).toEqual([]);
    unsubscribe();
    unsubscribeOther();
    store.dispose();
  });
});
