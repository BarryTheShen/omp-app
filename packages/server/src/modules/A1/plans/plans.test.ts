import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AppFailure,
  type PlanDocumentInput,
  PlanDocumentStore,
  ThreadId,
} from "@omp-app/contracts";
import type { A1PortContext } from "../ports/context";
import { createPlanDocumentRegistration } from "../ports/plan-documents";
import { createPlanDocumentStore } from "./index";

const dataRoot = resolve(import.meta.dir, "../../../../../../.data");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function documentInput(threadId: string, markdown: string): PlanDocumentInput {
  return {
    id: `plan-${threadId}`,
    threadId: ThreadId.parse(threadId),
    markdown,
    sections: [{ id: "intro", heading: "Introduction", start: 0, end: 1 }],
    annotations: [],
    status: "draft",
  };
}

async function temporaryDirectory(): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const path = await mkdtemp(join(dataRoot, "a1-plans-"));
  temporaryRoots.push(path);
  return path;
}

describe("createPlanDocumentStore", () => {
  test("loads missing plans without creating app data and saves through atomic revisions", async () => {
    const appDataDir = join(await temporaryDirectory(), "app-data");
    const store = createPlanDocumentStore({ appDataDir, now: () => "2026-10-05T00:00:00.000Z" });
    const threadId = ThreadId.parse("thread-plan");

    expect(await store.load({ threadId })).toEqual({ document: null, revisions: [] });
    const saved = await store.save({
      document: documentInput(threadId, "# Plan\n"),
      expectedRevision: 0,
    });

    expect(PlanDocumentStore.methods.save.result.safeParse(saved).success).toBe(true);
    expect(saved.document).toMatchObject({ revision: 1, updatedAt: "2026-10-05T00:00:00.000Z" });
    expect(saved.revisions).toEqual([]);
    expect((await store.load({ threadId })).document?.markdown).toBe("# Plan\n");
    expect(await containsSessionFile(appDataDir)).toBe(false);
  });

  test("keeps bounded previous document snapshots and emits scoped changes", async () => {
    const appDataDir = await temporaryDirectory();
    const store = createPlanDocumentStore({ appDataDir, maxHistory: 2 });
    const threadId = ThreadId.parse("thread-history");
    const changes: string[] = [];
    const unsubscribe = store.subscribe(threadId, (change) => {
      changes.push(`${change.threadId}:${change.document.revision}`);
    });

    await store.save({ document: documentInput(threadId, "one"), expectedRevision: 0 });
    await store.save({ document: documentInput(threadId, "two"), expectedRevision: 1 });
    await store.save({ document: documentInput(threadId, "three"), expectedRevision: 2 });
    unsubscribe();

    const loaded = await store.load({ threadId });
    expect(loaded.document?.revision).toBe(3);
    expect(loaded.revisions.map((revision) => revision.markdown)).toEqual(["two", "one"]);
    expect(changes).toEqual(["thread-history:1", "thread-history:2", "thread-history:3"]);
  });
  test("exposes the plan port through A1.9's registration helper", () => {
    const registration = createPlanDocumentRegistration({
      planDocumentStore: createPlanDocumentStore({ appDataDir: join(dataRoot, "handler-data") }),
      publish: () => undefined,
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext);

    expect(registration.port).toBe(PlanDocumentStore);
    expect(Object.keys(registration.handlers)).toEqual(["load", "save", "export"]);
  });

  test("returns a plain conflict for a stale compare-and-swap revision", async () => {
    const store = createPlanDocumentStore({ appDataDir: await temporaryDirectory() });
    const threadId = ThreadId.parse("thread-conflict");
    await store.save({ document: documentInput(threadId, "one"), expectedRevision: 0 });

    const error = await store
      .save({ document: documentInput(threadId, "stale"), expectedRevision: 0 })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError).toEqual({
      code: "conflict",
      message: "The plan changed; reload before saving.",
      retryable: true,
    });
  });

  test("rejects annotations that refer to no section and exports both formats", async () => {
    const store = createPlanDocumentStore({ appDataDir: await temporaryDirectory() });
    const threadId = ThreadId.parse("thread-export");
    const invalid = {
      ...documentInput(threadId, "draft"),
      annotations: [
        {
          id: "annotation-1",
          sectionId: "missing",
          text: "bad",
          createdAt: "2026-10-05T00:00:00.000Z",
          updatedAt: "2026-10-05T00:00:00.000Z",
        },
      ],
    };
    const invalidError = await store
      .save({ document: invalid, expectedRevision: 0 })
      .catch((cause: unknown) => cause);
    expect(invalidError).toBeInstanceOf(AppFailure);
    expect((invalidError as AppFailure).appError.code).toBe("invalid_args");

    const saved = await store.save({
      document: documentInput(threadId, "# Export"),
      expectedRevision: 0,
    });
    if (saved.document === null) throw new Error("Expected a saved document");
    const documentId = saved.document.id;
    const markdown = await store.export({ documentId, format: "markdown" });
    const json = await store.export({ documentId, format: "json" });
    expect(markdown.text).toBe("# Export");
    expect(JSON.parse(json.text)).toMatchObject({ id: documentId, revision: 1 });
  });

  test("uses a not_found failure for an unknown export id", async () => {
    const store = createPlanDocumentStore({ appDataDir: await temporaryDirectory() });
    const error = await store
      .export({ documentId: "missing-plan", format: "markdown" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).appError.code).toBe("not_found");
  });
});

async function containsSessionFile(root: string): Promise<boolean> {
  const names = await listFiles(root);
  return names.some((name) => name.endsWith(".jsonl"));
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
