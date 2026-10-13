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
import { describe, expect, test, vi } from "vitest";
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
    displayTitle: id,
    firstPrompt: null,
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

/** A folder with `total` chats, newest first, paged by numeric cursors like the server's list. */
function pagedFolder(total: number) {
  const all = Array.from({ length: total }, (_, index) =>
    session(
      `chat-${String(index).padStart(3, "0")}`,
      new Date(Date.UTC(2026, 9, 5) - index * 60_000).toISOString(),
    ),
  );
  const requests: Array<{ cursor: string | undefined; limit: number | undefined }> = [];
  const sessionFiles = {
    listSessions: async ({
      cursor,
      limit,
    }: {
      folder: FolderPath;
      cursor?: string;
      limit?: number;
    }) => {
      requests.push({ cursor, limit });
      const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      const end = Math.min(start + (limit ?? 100), total);
      return { sessions: all.slice(start, end), nextCursor: end < total ? String(end) : null };
    },
    readSession: async () => all[0] as SessionFile,
  };
  return { requests, sessionFiles };
}

describe("SessionCatalogModel older pages", () => {
  test("loadMore adds the next page after the chats shown and stops when there are no more", async () => {
    const { requests, sessionFiles } = pagedFolder(130);
    const model = new SessionCatalogModel({ scope, sessionFiles });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    expect(model.getSnapshot().sessions).toHaveLength(50);
    expect(model.getSnapshot().nextCursor).toBe("50");

    await model.loadMore(50);
    expect(model.getSnapshot().sessions).toHaveLength(100);
    expect(model.getSnapshot().nextCursor).toBe("100");
    await model.loadMore(50);
    const snapshot = model.getSnapshot();
    expect(snapshot.sessions).toHaveLength(130);
    expect(snapshot.nextCursor).toBeNull();
    expect(snapshot.isLoadingMore).toBe(false);
    expect(snapshot.sessions.map((item) => item.id)).toEqual(
      Array.from({ length: 130 }, (_, index) => `chat-${String(index).padStart(3, "0")}`),
    );

    const before = requests.length;
    await model.loadMore(50);
    expect(requests).toHaveLength(before);
  });

  test("a second loadMore while one is loading makes no second request", async () => {
    const { requests, sessionFiles } = pagedFolder(120);
    const model = new SessionCatalogModel({ scope, sessionFiles });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    const first = model.loadMore(50);
    const second = model.loadMore(50);
    await Promise.all([first, second]);
    expect(requests.filter((request) => request.cursor === "50")).toHaveLength(1);
    expect(model.getSnapshot().sessions).toHaveLength(100);
  });

  test("a failed loadMore keeps the chats shown, says why, and the next try clears it", async () => {
    const { sessionFiles } = pagedFolder(120);
    let failing = true;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        ...sessionFiles,
        listSessions: async (args) => {
          if (failing && args.cursor === "50") {
            throw new AppFailure({ code: "internal", message: "disk busy", retryable: true });
          }
          return sessionFiles.listSessions(args);
        },
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    await model.loadMore(50);
    let snapshot = model.getSnapshot();
    expect(snapshot.sessions).toHaveLength(50);
    expect(snapshot.moreError?.message).toBe("disk busy");
    // The list itself did not fail: it stays on screen and `error` stays empty.
    expect(snapshot.error).toBeNull();
    expect(snapshot.isLoading).toBe(false);
    expect(snapshot.isLoadingMore).toBe(false);

    failing = false;
    await model.loadMore(50);
    snapshot = model.getSnapshot();
    expect(snapshot.sessions).toHaveLength(100);
    expect(snapshot.moreError).toBeNull();
  });

  test("a loadMore the server refuses as a stale cursor reads the list again, and the next try works", async () => {
    const { sessionFiles } = pagedFolder(120);
    let firstPageIsStale = true;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        ...sessionFiles,
        listSessions: async (args) => {
          // The server refuses a cursor it did not issue, as it does for one from before it changed.
          if (args.cursor === "stale") {
            throw new AppFailure({
              code: "invalid_args",
              message: "Invalid session-list cursor",
              retryable: false,
            });
          }
          const page = await sessionFiles.listSessions(args);
          if (args.cursor === undefined && firstPageIsStale) {
            firstPageIsStale = false;
            return { ...page, nextCursor: "stale" };
          }
          return page;
        },
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    expect(model.getSnapshot().nextCursor).toBe("stale");

    await model.loadMore(50);
    let snapshot = model.getSnapshot();
    // The refused cursor is dropped without a message, and the first page is read again.
    expect(snapshot.moreError).toBeNull();
    expect(snapshot.error).toBeNull();
    expect(snapshot.sessions).toHaveLength(50);
    expect(snapshot.nextCursor).toBe("50");

    await model.loadMore(50);
    snapshot = model.getSnapshot();
    expect(snapshot.sessions).toHaveLength(100);
    expect(snapshot.moreError).toBeNull();
  });

  test("a page that arrives after a newer list began is dropped", async () => {
    const { sessionFiles } = pagedFolder(120);
    const gate = Promise.withResolvers<void>();
    let hold = false;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        ...sessionFiles,
        listSessions: async (args) => {
          if (hold && args.cursor === "50") await gate.promise;
          return sessionFiles.listSessions(args);
        },
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    hold = true;
    const more = model.loadMore(50);
    hold = false;
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    gate.resolve();
    await more;
    expect(model.getSnapshot().sessions).toHaveLength(50);
    expect(model.getSnapshot().nextCursor).toBe("50");
    expect(model.getSnapshot().isLoadingMore).toBe(false);
  });

  test("refreshing the same list keeps as many chats on screen as it had", async () => {
    const { requests, sessionFiles } = pagedFolder(130);
    const model = new SessionCatalogModel({ scope, sessionFiles });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    await model.loadMore(50);
    await model.loadMore(50);
    expect(model.getSnapshot().sessions).toHaveLength(130);

    requests.length = 0;
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    expect(model.getSnapshot().sessions).toHaveLength(130);
    expect(model.getSnapshot().nextCursor).toBeNull();
    expect(requests.map((request) => request.cursor)).toEqual([undefined, "50", "100"]);
  });
  test("a loaded empty catalog stays ready during a background refresh", async () => {
    const pendingRefresh = Promise.withResolvers<{ sessions: SessionFile[]; nextCursor: null }>();
    let calls = 0;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => {
          calls += 1;
          return calls === 1 ? { sessions: [], nextCursor: null } : pendingRefresh.promise;
        },
        readSession: async () => session("unused", "2026-10-01T00:00:00.000Z"),
      },
    });
    const args = { filter: { scope, query: "" }, limit: 50 };

    await model.list(args);
    expect(model.getSnapshot().isLoaded).toBe(true);
    const refresh = model.list(args);

    expect(model.getSnapshot().isLoaded).toBe(true);
    expect(model.getSnapshot().isLoading).toBe(false);
    expect(model.getSnapshot().sessions).toEqual([]);

    pendingRefresh.resolve({ sessions: [], nextCursor: null });
    await refresh;
    expect(model.getSnapshot().error).toBeNull();
  });

  test("a different filter starts from the first page again", async () => {
    const { requests, sessionFiles } = pagedFolder(130);
    const model = new SessionCatalogModel({ scope, sessionFiles });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    await model.loadMore(50);
    requests.length = 0;
    await model.list({ filter: { scope, query: "chat-0" }, limit: 50 });
    // A search looks through every chat, so it pages to the end by itself.
    expect(requests.map((request) => request.cursor)).toEqual([undefined, "50", "100"]);
  });

  test("a search finds a chat on a page that was never shown", async () => {
    const { sessionFiles } = pagedFolder(130);
    const model = new SessionCatalogModel({ scope, sessionFiles });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    const page = await model.list({ filter: { scope, query: "chat-129" }, limit: 50 });
    expect(page.sessions.map((item) => item.id)).toEqual(["chat-129"]);
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

  test("a refusal of a delete while its chat's turn runs ends when that turn does", async () => {
    const running = { ...session("one", "2026-10-03T00:00:00.000Z"), turn: "running" as const };
    const settled = { ...running, turn: "idle" as const };
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [running], nextCursor: null }),
        readSession: async () => settled,
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });
    model.setActionError("Wait for this chat's turn to finish, then delete it.", running.id);

    await model.reconcile({
      folder,
      sessionFile: running.sessionFile,
      id: running.id,
      kind: "updated",
    });

    expect(model.getSnapshot().actionError).toBeUndefined();
  });

  test("a refusal of a delete stays while its chat's turn still runs", async () => {
    const running = { ...session("one", "2026-10-03T00:00:00.000Z"), turn: "running" as const };
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [running], nextCursor: null }),
        readSession: async () => ({ ...running, title: "Renamed while running" }),
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });
    model.setActionError("Wait for this chat's turn to finish, then delete it.", running.id);

    await model.reconcile({
      folder,
      sessionFile: running.sessionFile,
      id: running.id,
      kind: "updated",
    });

    expect(model.getSnapshot().actionError).toBe(
      "Wait for this chat's turn to finish, then delete it.",
    );
  });

  test("a changed chat that does not match the search is not added to the results", async () => {
    const match = session("alpha", "2026-10-03T00:00:00.000Z");
    const other = session("beta", "2026-10-04T00:00:00.000Z");
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [match], nextCursor: null }),
        readSession: async () => other,
      },
    });
    await model.list({ filter: { scope, query: "alpha" }, limit: 20 });

    await model.reconcile({
      folder,
      sessionFile: other.sessionFile,
      id: other.id,
      kind: "updated",
    });

    expect(model.getSnapshot().sessions.map((item) => item.id)).toEqual([match.id]);
  });

  test("a listed chat that a change renames out of the search leaves the results", async () => {
    const original = {
      ...session("one", "2026-10-03T00:00:00.000Z"),
      title: "alpha notes",
      displayTitle: "alpha notes",
    };
    const renamed = { ...original, title: "Renamed", displayTitle: "Renamed" };
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [original], nextCursor: null }),
        readSession: async () => renamed,
      },
    });
    await model.list({ filter: { scope, query: "alpha" }, limit: 20 });

    await model.reconcile({
      folder,
      sessionFile: original.sessionFile,
      id: original.id,
      kind: "updated",
    });

    expect(model.getSnapshot().sessions).toEqual([]);
  });

  test("a changed chat that matches the search is added to the results", async () => {
    const match = session("alpha", "2026-10-03T00:00:00.000Z");
    const added = session("alpha-two", "2026-10-04T00:00:00.000Z");
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [match], nextCursor: null }),
        readSession: async () => added,
      },
    });
    await model.list({ filter: { scope, query: "alpha" }, limit: 20 });

    await model.reconcile({
      folder,
      sessionFile: added.sessionFile,
      id: added.id,
      kind: "updated",
    });

    expect(model.getSnapshot().sessions.map((item) => item.id)).toEqual([added.id, match.id]);
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

describe("SessionCatalogModel refresh after a rename", () => {
  test("re-reads a listed chat so its row shows the title saved in its file, and leaves other rows alone", async () => {
    const renamed = session("one", "2026-10-03T00:00:00.000Z");
    const other = session("two", "2026-10-02T00:00:00.000Z");
    let saved: SessionFile = renamed;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [renamed, other], nextCursor: null }),
        readSession: async ({ sessionFile }) =>
          sessionFile === renamed.sessionFile ? saved : other,
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });
    saved = { ...renamed, title: "Renamed in place" };

    await model.refresh(renamed.id);

    expect(model.getSnapshot().sessions.map((item) => [item.id, item.title])).toEqual([
      [renamed.id, "Renamed in place"],
      [other.id, other.title],
    ]);
  });

  test("a refresh never adds a chat the list does not hold, and never brings back a removed one", async () => {
    const listed = session("one", "2026-10-03T00:00:00.000Z");
    const unlisted = session("two", "2026-10-02T00:00:00.000Z");
    let reads = 0;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [listed], nextCursor: null }),
        readSession: async () => {
          reads += 1;
          return unlisted;
        },
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });

    await model.refresh(unlisted.id);
    expect(model.getSnapshot().sessions.map((item) => item.id)).toEqual([listed.id]);

    await model.reconcile({
      folder,
      sessionFile: listed.sessionFile,
      id: listed.id,
      kind: "removed",
    });
    await model.refresh(listed.id);
    expect(model.getSnapshot().sessions).toEqual([]);
    expect(reads).toBe(0);
  });

  test("a chat whose file cannot be read keeps its row and reports the failure", async () => {
    const listed = session("one", "2026-10-03T00:00:00.000Z");
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [listed], nextCursor: null }),
        readSession: async () => {
          throw new AppFailure({
            code: "not_found",
            message: "The file is gone.",
            retryable: false,
          });
        },
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });

    await model.refresh(listed.id);

    expect(model.getSnapshot().sessions.map((item) => item.id)).toEqual([listed.id]);
    expect(model.getSnapshot().error).not.toBeNull();
  });
});

describe("SessionCatalogModel: a list or an update that overlaps another", () => {
  test("a list that began before a turn ended keeps the chat's ended row, not its running copy", async () => {
    const running: SessionFile = { ...session("one", "2026-10-03T00:00:00.000Z"), turn: "running" };
    const ended: SessionFile = { ...session("one", "2026-10-03T00:00:05.000Z"), turn: "idle" };
    const listed = Promise.withResolvers<{ sessions: SessionFile[]; nextCursor: null }>();
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: () => listed.promise,
        readSession: async () => ended,
      },
    });
    const pending = model.list({ filter: { scope, query: "" }, limit: 20 });
    await model.reconcile({
      folder,
      sessionFile: ended.sessionFile,
      id: ended.id,
      kind: "updated",
    });
    listed.resolve({ sessions: [running], nextCursor: null });
    await pending;

    expect(model.getSnapshot().sessions).toMatchObject([{ id: ended.id, turn: "idle" }]);
  });

  test("an update that began before a list is not dropped by that list", async () => {
    const before = session("one", "2026-10-03T00:00:00.000Z");
    const after: SessionFile = { ...before, turn: "idle", updatedAt: "2026-10-03T00:00:05.000Z" };
    const read = Promise.withResolvers<SessionFile>();
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [before], nextCursor: null }),
        readSession: () => read.promise,
      },
    });
    const update = model.reconcile({
      folder,
      sessionFile: after.sessionFile,
      id: after.id,
      kind: "updated",
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });
    read.resolve(after);
    await update;

    expect(model.getSnapshot().sessions).toMatchObject([
      { id: after.id, turn: "idle", updatedAt: after.updatedAt },
    ]);
  });

  test("a chat removed while a list is loading is left out of the list that finishes", async () => {
    const gone = session("gone", "2026-10-03T00:00:00.000Z");
    const kept = session("kept", "2026-10-02T00:00:00.000Z");
    const listed = Promise.withResolvers<{ sessions: SessionFile[]; nextCursor: null }>();
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: () => listed.promise,
        readSession: async () => gone,
      },
    });
    const pending = model.list({ filter: { scope, query: "" }, limit: 20 });
    await model.reconcile({ folder, sessionFile: gone.sessionFile, id: gone.id, kind: "removed" });
    listed.resolve({ sessions: [gone, kept], nextCursor: null });
    await pending;

    expect(model.getSnapshot().sessions.map((item) => item.id)).toEqual([kept.id]);
  });

  test("a failed refresh that an update overtook still reports its error", async () => {
    const listed = session("one", "2026-10-03T00:00:00.000Z");
    let failing = false;
    const held = Promise.withResolvers<{ sessions: SessionFile[]; nextCursor: null }>();
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: () =>
          failing ? held.promise : Promise.resolve({ sessions: [listed], nextCursor: null }),
        readSession: async () => listed,
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 20 });
    failing = true;
    const refresh = model.list({ filter: { scope, query: "" }, limit: 20 });
    await model.reconcile({
      folder,
      sessionFile: listed.sessionFile,
      id: listed.id,
      kind: "updated",
    });
    held.reject(
      new AppFailure({ code: "unavailable", message: "the disk is busy", retryable: true }),
    );
    await expect(refresh).rejects.toMatchObject({ appError: { message: "the disk is busy" } });

    expect(model.getSnapshot().error).toMatchObject({ message: "the disk is busy" });
    expect(model.getSnapshot().sessions).toHaveLength(1);
  });
});

describe("SessionCatalogModel running chats", () => {
  test("keeps the chats running with no session file, and lists none while a search is typed", async () => {
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({
          sessions: [],
          nextCursor: null,
          running: [{ id: ThreadIdSchema.parse("first-reply"), folder }],
        }),
        readSession: async () => {
          throw new Error("No chat has a session file to read yet.");
        },
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 50 });
    expect(model.getSnapshot().running.map((chat) => chat.id)).toEqual(["first-reply"]);

    await model.list({ filter: { scope, query: "first" }, limit: 50 });
    expect(model.getSnapshot().running).toEqual([]);
  });

  test("only the first page names the running chats: a page loaded later leaves them as they are", async () => {
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async ({ cursor }) =>
          cursor === undefined
            ? {
                sessions: [session("one", "2026-10-03T00:00:00.000Z")],
                nextCursor: "page-2",
                running: [{ id: ThreadIdSchema.parse("first-reply"), folder }],
              }
            : {
                sessions: [session("two", "2026-10-02T00:00:00.000Z")],
                nextCursor: null,
                running: [{ id: ThreadIdSchema.parse("later"), folder }],
              },
        readSession: async () => {
          throw new Error("No chat has a session file to read in this test.");
        },
      },
    });
    await model.list({ filter: { scope, query: "" }, limit: 1 });
    await model.loadMore(1);
    expect(model.getSnapshot().sessions.map((chat) => chat.id)).toEqual(["one", "two"]);
    expect(model.getSnapshot().running.map((chat) => chat.id)).toEqual(["first-reply"]);
  });
});

describe("SessionCatalogModel first load", () => {
  test("remembers the moment its list first loaded, and keeps that moment through later lists", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      const model = new SessionCatalogModel({
        scope,
        sessionFiles: {
          listSessions: async () => ({ sessions: [], nextCursor: null, running: [] }),
          readSession: async () => {
            throw new Error("No chat has a session file to read in this test.");
          },
        },
      });
      expect(model.firstLoadedAt).toBeNull();

      clock.mockReturnValue(1_000);
      await model.list({ filter: { scope, query: "" }, limit: 50 });
      expect(model.firstLoadedAt).toBe(1_000);

      clock.mockReturnValue(9_000);
      await model.list({ filter: { scope, query: "" }, limit: 50 });
      expect(model.firstLoadedAt).toBe(1_000);
    } finally {
      clock.mockRestore();
    }
  });
});
