import type {
  FolderPath,
  GitState,
  Revision,
  SessionFile,
  SessionFileChanged,
  SessionPinListResult,
  WorkspaceState,
} from "@omp-app/contracts";
import { AppFailure, SessionFilePath, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SessionScope } from "../contract";
import { SessionCatalogModel } from ".";

const folder = "/workspace/project" as FolderPath;
const worktree = "/workspace/project-worktree" as FolderPath;
const scope: SessionScope = { kind: "folder", folder };
const projectScope: SessionScope = {
  kind: "project",
  folder,
  repositoryRoot: "/workspace" as FolderPath,
};

function session(id: string, updatedAt: string, cwd = folder): SessionFile {
  return {
    id: ThreadIdSchema.parse(id),
    sessionFile: SessionFilePath.parse(`${cwd}/.omp/${id}.jsonl`),
    version: 3,
    title: id,
    cwd,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt,
    parentSession: null,
    messageCount: 2,
    assistantTurns: 1,
    sizeBytes: 100,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
  };
}

function gitState(): GitState {
  return {
    repositoryRoot: "/workspace" as FolderPath,
    branch: "main",
    head: "head",
    detached: false,
    dirtyFiles: [],
    ahead: 0,
    behind: 0,
    worktrees: [
      {
        path: worktree,
        head: "head-2",
        branch: "feature",
        detached: false,
        bare: false,
        locked: false,
      },
    ],
    observedAt: "2026-10-05T00:00:00.000Z",
  };
}

function workspace(): WorkspaceState {
  return {
    folder,
    additionalDirectories: [],
    git: gitState(),
    observedAt: "2026-10-05T00:00:00.000Z",
  };
}

describe("SessionCatalogModel list/sort/filter", () => {
  test("sorts pinned first, then updated descending, and pages through A1", async () => {
    const sessions = [
      session("old", "2026-10-01T00:00:00.000Z"),
      session("new", "2026-10-03T00:00:00.000Z"),
      session("pinned", "2026-10-02T00:00:00.000Z"),
    ];
    const calls: unknown[] = [];
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async (args) => {
          calls.push(args);
          return { sessions, nextCursor: "cursor-2" };
        },
        readSession: async ({ sessionFile }) =>
          sessions.find((item) => item.sessionFile === sessionFile) as SessionFile,
      },
      pins: {
        list: async () =>
          ({
            pins: [{ sessionId: ThreadIdSchema.parse("pinned"), pinned: true }],
            revision: "r1" as Revision,
            readAt: "2026-10-05T00:00:00.000Z",
          }) satisfies SessionPinListResult,
      },
    });

    const page = await model.list({ filter: { scope, query: "" }, limit: 2 });

    expect(page.nextCursor).toBe("cursor-2");
    expect(page.sessions.map((item) => item.id)).toEqual(["pinned", "new", "old"]);
    expect(page.sessions[0]?.pinned).toBe(true);
    expect(calls).toEqual([{ folder, limit: 2 }]);
  });

  test("filters title/id/cwd case-insensitively and uses project worktrees", async () => {
    const sessions = [session("feature", "2026-10-03T00:00:00.000Z", worktree)];
    const folders: FolderPath[] = [];
    const model = new SessionCatalogModel({
      scope: projectScope,
      sessionFiles: {
        listSessions: async ({ folder: selected }) => {
          folders.push(selected);
          return { sessions, nextCursor: null };
        },
        readSession: async () => sessions[0] as SessionFile,
      },
      gitState: { read: async () => workspace() },
    });

    const page = await model.list({
      filter: { scope: projectScope, query: "FEATURE" },
      limit: 50,
    });

    expect(folders).toEqual(["/workspace", worktree]);
    expect(page.sessions.map((item) => item.id)).toEqual(["feature"]);
  });
});

describe("SessionCatalogModel reconciliation", () => {
  test("updates a renamed session in place without changing its identity", async () => {
    const original = session("one", "2026-10-03T00:00:00.000Z");
    const renamed = { ...original, title: "Renamed" };
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [original], nextCursor: null }),
        readSession: async () => renamed,
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });

    const change: SessionFileChanged = {
      folder,
      sessionFile: original.sessionFile,
      id: original.id,
      kind: "updated",
    };
    await model.reconcile(change);

    expect(model.getSnapshot().sessions).toHaveLength(1);
    expect(model.getSnapshot().sessions[0]).toMatchObject({ id: original.id, title: "Renamed" });
  });

  test("a stale update resolving after remove cannot resurrect a deleted session", async () => {
    const original = session("one", "2026-10-03T00:00:00.000Z");
    let resolveRead!: (value: SessionFile) => void;
    const pending = new Promise<SessionFile>((resolve) => {
      resolveRead = resolve;
    });
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [original], nextCursor: null }),
        readSession: async () => pending,
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });

    const update = model.reconcile({
      folder,
      sessionFile: original.sessionFile,
      id: original.id,
      kind: "updated",
    });
    await model.reconcile({
      folder,
      sessionFile: original.sessionFile,
      id: original.id,
      kind: "removed",
    });
    resolveRead({ ...original, title: "stale rename" });
    await update;

    expect(model.getSnapshot().sessions).toEqual([]);
  });

  test("drops a delete tombstone after a later full load so a restored id can reappear", async () => {
    const original = session("restored", "2026-10-03T00:00:00.000Z");
    let listCalls = 0;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => {
          listCalls += 1;
          return { sessions: listCalls === 1 ? [original] : [original], nextCursor: null };
        },
        readSession: async () => original,
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });
    await model.reconcile({
      folder,
      sessionFile: original.sessionFile,
      id: original.id,
      kind: "removed",
    });
    expect(model.getSnapshot().sessions).toEqual([]);

    await model.list({ filter: { scope, query: "" }, limit: 20 });
    expect(model.getSnapshot().sessions.map((item) => item.id)).toEqual([original.id]);
  });

  test("caps tombstone retention at the newest thousand ids", async () => {
    const first = session("deleted-0", "2026-10-03T00:00:00.000Z");
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [], nextCursor: null }),
        readSession: async () => first,
      },
    });
    for (let index = 0; index <= 1_000; index += 1) {
      const id = ThreadIdSchema.parse(`deleted-${index}`);
      await model.reconcile({
        folder,
        sessionFile: SessionFilePath.parse(`${folder}/.omp/${id}.jsonl`),
        id,
        kind: "removed",
      });
    }

    await model.reconcile({
      folder,
      sessionFile: first.sessionFile,
      id: first.id,
      kind: "updated",
    });
    expect(model.getSnapshot().sessions.map((item) => item.id)).toEqual([first.id]);
  });

  test("reconcile ignores an event outside the selected folder", async () => {
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [], nextCursor: null }),
        readSession: async () => session("outside", "2026-10-03T00:00:00.000Z"),
      },
    });
    await model.reconcile({
      folder: "/workspace/other" as FolderPath,
      sessionFile: SessionFilePath.parse("/workspace/other/.omp/one.jsonl"),
      id: ThreadIdSchema.parse("outside"),
      kind: "created",
    });
    expect(model.getSnapshot().sessions).toEqual([]);
  });
});

describe("SessionCatalogModel errors and immutable snapshots", () => {
  test("surfaces AppFailure and preserves the previous session page", async () => {
    const failure = new AppFailure({ code: "permission", message: "denied", retryable: false });
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => {
          throw failure;
        },
        readSession: async () => session("never", "2026-10-03T00:00:00.000Z"),
      },
    });

    await expect(model.list({ filter: { scope, query: "" }, limit: 20 })).rejects.toBe(failure);
    expect(model.getSnapshot().error).toEqual(failure.appError);
    expect(model.getSnapshot().sessions).toEqual([]);
  });

  test("publishes immutable snapshots and preserves unchanged references on no-op updates", async () => {
    const one = session("one", "2026-10-03T00:00:00.000Z");
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [one], nextCursor: null }),
        readSession: async () => one,
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });
    const first = model.getSnapshot();
    await model.reconcile({
      folder: "/workspace/other" as FolderPath,
      sessionFile: SessionFilePath.parse("/workspace/other/.omp/no.jsonl"),
      id: ThreadIdSchema.parse("no"),
      kind: "updated",
    });
    expect(model.getSnapshot().sessions).toBe(first.sessions);
    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
  });
});
