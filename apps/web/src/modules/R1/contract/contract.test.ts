import type { ThreadId } from "@omp-app/contracts";
import { AppFailure, SessionFilePath, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  isCurrentSelection,
  ProjectSessionScope,
  RemoteThreadListPage,
  SessionCatalogFilter,
  SessionCatalogPageArgs,
  SessionCatalogSelection,
  SessionMetadata,
  SessionProvenance,
  SessionScope,
} from ".";

const folder = "/workspace/project";
const sessionFile = "/workspace/project/.omp/2026-10-05_session.jsonl";
const threadId = ThreadIdSchema.parse("thread-1");

const baseSession = {
  id: threadId,
  sessionFile: SessionFilePath.parse(sessionFile),
  version: 3,
  title: "A session",
  firstPrompt: null,
  cwd: folder,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:01:00.000Z",
  parentSession: null,
  messageCount: 2,
  assistantTurns: 1,
  sizeBytes: 100,
  status: "complete" as const,
  liveness: { lease: "free" as const, serverProcess: false },
  subagents: [],
  parseWarnings: [],
  scope: { kind: "folder" as const, folder },
  provenance: "native" as const,
  pinned: true,
};

describe("R1 scopes and metadata", () => {
  test("accepts folder/project scopes and rejects malformed scope combinations", () => {
    expect(SessionScope.parse({ kind: "folder", folder })).toMatchObject({ kind: "folder" });
    expect(
      SessionScope.parse({ kind: "project", folder, repositoryRoot: "/workspace" }),
    ).toMatchObject({ kind: "project" });
    expect(SessionScope.safeParse({ kind: "project", folder }).success).toBe(false);
    expect(ProjectSessionScope.safeParse({ kind: "folder", folder }).success).toBe(false);
  });

  test("reuses A1 session metadata and adds native/import/pin presentation fields", () => {
    expect(SessionMetadata.parse(baseSession)).toMatchObject({
      id: "thread-1",
      provenance: "native",
      pinned: true,
    });
    expect(SessionProvenance.safeParse("claude").success).toBe(true);
    expect(SessionProvenance.safeParse("foreign-file").success).toBe(false);
  });

  test("keeps catalog filtering and cursors opaque and bounded", () => {
    const filter = SessionCatalogFilter.parse({
      scope: { kind: "folder", folder },
      query: "agent",
    });
    expect(filter.query).toBe("agent");
    expect(SessionCatalogPageArgs.parse({ filter, limit: 20 }).limit).toBe(20);
    expect(SessionCatalogPageArgs.safeParse({ filter, limit: 0 }).success).toBe(false);
    expect(
      RemoteThreadListPage.parse({
        threads: [{ status: "regular", remoteId: "thread-1" }],
        nextCursor: "cursor-2",
      }).nextCursor,
    ).toBe("cursor-2");
  });
});

describe("R1 stale selection", () => {
  test("only the current revision and thread may commit an async open", () => {
    const selection = SessionCatalogSelection.parse({ currentThreadId: threadId, revision: 4 });
    expect(isCurrentSelection({ threadId, revision: 4 }, selection)).toBe(true);
    expect(isCurrentSelection({ threadId, revision: 3 }, selection)).toBe(false);
    expect(isCurrentSelection({ threadId: "other" as ThreadId, revision: 4 }, selection)).toBe(
      false,
    );
  });

  test("stale opens can be represented as typed failures without file writes", () => {
    const failure = new AppFailure({
      code: "conflict",
      message: "Selection changed",
      retryable: true,
    });
    expect(failure.appError.code).toBe("conflict");
  });
});
