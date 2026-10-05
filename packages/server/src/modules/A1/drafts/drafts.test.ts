import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function waitForWatchers(): Promise<void> {
  // Real fs.watch delivery and debounce are the integration under test.
  await Bun.sleep(260);
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
    store.dispose();
  });

  test("prunes failed-send history to the newest 20 entries per scope", async () => {
    const root = await temporaryDirectory();
    const store = new DraftStoreService({ appDataDir: join(root, "app") });
    const failedSends = Array.from({ length: 21 }, (_, index) => ({
      attemptedAt: `2026-10-04T00:00:${String(index).padStart(2, "0")}Z`,
      text: `failed-${index}`,
      attachments: [attachment()],
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

  test("emits one external change and none for own saves or clears", async () => {
    const root = await temporaryDirectory();
    const app = join(root, "app");
    const scope = { kind: "thread" as const, threadId: "events" };
    const events: unknown[] = [];
    const store = new DraftStoreService({ appDataDir: app });
    const unsubscribe = store.subscribe(scope, (change) => {
      events.push(change);
    });
    await waitForWatchers();
    const saved = await store.save({ scope, draft: draftInput("own"), expectedRevision: null });
    await waitForWatchers();
    expect(events).toHaveLength(0);

    const path = join(store.draftsDir, "threads", `${hashContent("events")}.json`);
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        kind: "draft",
        scope,
        text: "external",
        attachments: [attachment()],
        failedSends: [],
        updatedAt: "2026-10-04T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await waitForWatchers();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain("external");

    await store.clear({
      scope,
      expectedRevision: (await store.get({ scope })).draft?.revision ?? saved.revision,
    });
    await waitForWatchers();
    expect(events).toHaveLength(1);
    unsubscribe();
    store.dispose();
  });
});
