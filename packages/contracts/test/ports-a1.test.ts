import { describe, expect, test } from "bun:test";
import { EntryId, FolderPath, SessionFilePath, ThreadId } from "../src/core/ids";
import {
  CheckpointDiff,
  CheckpointListArgs,
  CheckpointListResult,
  CheckpointSnapshotArgs,
  CheckpointStore,
  CommandOutputEvent,
  CommandRunArgs,
  CommandRunResult,
  ConfigChanged,
  ConfigEntry,
  ConfigListResult,
  ConfigStore,
  ConfigWriteArgs,
  ConfigWriteValue,
  type ConversationHead,
  Draft,
  DraftChanged,
  DraftGetResult,
  DraftSaveArgs,
  DraftStore,
  GitState,
  GitStatePort,
  OmpCommandGateway,
  RestorePlan,
  RestoreResult,
  SecretStatus,
  SessionFile,
  SessionFileChanged,
  SessionFileStore,
  SessionPinChanged,
  SessionPinListResult,
  SessionPinSetArgs,
  SessionPinStore,
  SnapshotRecord,
  WorkspaceState,
  WorkspaceStatePort,
} from "../src/ports/A1";

const folder = FolderPath.parse("/workspace/project");
const sessionFile = SessionFilePath.parse(
  "/home/user/.omp/agent/sessions/-workspace/2026-10-04T00-00-00-000Z_thread-1.jsonl",
);
const threadId = ThreadId.parse("thread-1");
const entryId = EntryId.parse("entry-1");
const revision = "sha256:abc";
const conversation: ConversationHead = {
  threadId,
  sessionFile,
  entryId,
};

const session = {
  id: threadId,
  sessionFile,
  version: 3,
  title: "A session",
  cwd: folder,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:01:00.000Z",
  parentSession: null,
  messageCount: 2,
  assistantTurns: 1,
  sizeBytes: 512,
  status: "complete" as const,
  liveness: { lease: "free" as const, serverProcess: false },
  subagents: [
    {
      key: "ToolAsk/Helper",
      agentId: "Helper",
      parent: "ToolAsk",
      sessionFile: `${sessionFile.slice(0, -6)}/ToolAsk/Helper.jsonl`,
      leafId: "entry-child",
      entryCount: 3,
      aborted: false,
    },
  ],
  parseWarnings: [],
};

const configValue = {
  key: "compaction.enabled",
  secret: false as const,
  value: true,
  source: "project" as const,
  overrides: ["global" as const],
  provenance: { origin: "omp-config" as const, path: `${folder}/.omp/config.yml` },
};

const configSecret = {
  key: "provider.apiKey",
  secret: true as const,
  isSet: true,
  source: "global" as const,
  overrides: [],
  provenance: { origin: "omp-config" as const },
};

const draft = {
  scope: { kind: "thread" as const, threadId },
  text: "continue from here",
  attachments: [{ id: "attachment-1", name: "notes.txt", mediaType: "text/plain", sizeBytes: 12 }],
  failedSends: [
    {
      attemptedAt: "2026-10-04T00:00:00.000Z",
      text: "continue from here",
      attachments: [],
      reason: "connection lost",
    },
  ],
  revision,
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const git = {
  repositoryRoot: folder,
  branch: "main",
  head: "0123456789abcdef",
  detached: false,
  dirtyFiles: [{ path: "src/app.ts", status: "modified" as const, staged: false, worktree: true }],
  ahead: 1,
  behind: 0,
  worktrees: [
    {
      path: folder,
      head: "0123456789abcdef",
      branch: "main",
      detached: false,
      bare: false,
      locked: false,
    },
  ],
  observedAt: "2026-10-04T00:00:00.000Z",
};

const snapshot = {
  snapshotId: "snapshot-1",
  workspaceKey: "workspace-key",
  ompSessionId: threadId,
  sessionFile,
  entryId: "entry-1",
  capturedAt: "2026-10-04T00:00:00.000Z",
  parentSnapshotId: null,
  source: "prompt-boundary" as const,
  includedPaths: [
    {
      path: "src/app.ts",
      kind: "file" as const,
      mode: 0o644,
      hash: "sha256:file",
      sizeBytes: 64,
    },
  ],
  excludedPaths: [{ path: ".env", reason: "secret pattern" }],
  shadowTreeId: "tree-1",
  workspaceHash: revision,
  guarantee: "boundary" as const,
  pinned: true,
};

const restorePlan = {
  planId: "plan-1",
  workspace: folder,
  operation: "files-only" as const,
  snapshotId: snapshot.snapshotId,
  currentConversation: conversation,
  targetConversation: null,
  currentWorkspaceHash: revision,
  targetWorkspaceHash: "sha256:before",
  includedPaths: snapshot.includedPaths,
  excludedPaths: snapshot.excludedPaths,
  externalChanges: [],
  capturedPathCount: 1,
  snapshotGuarantee: "boundary" as const,
  destructive: true,
  requiresConfirmation: true,
};

const restoreResult = {
  planId: restorePlan.planId,
  operation: "files-only" as const,
  filesRestored: true,
  conversationRestored: false,
  capturedPathCount: 1,
  excludedPaths: [".env"],
  snapshotGuarantee: "boundary" as const,
  externalChanges: [],
  partialFailure: null,
  previousConversation: conversation,
  currentConversation: conversation,
  undoSnapshotId: "snapshot-undo",
  redoAvailable: true,
};

describe("A1 SessionFileStore and session pins", () => {
  test("accept representative listings and reject malformed paths", () => {
    expect(SessionFile.parse(session).id).toBe(threadId);
    expect(
      SessionFileStore.methods.listSessions.args.safeParse({ folder, limit: 20 }).success,
    ).toBe(true);
    expect(
      SessionFileStore.methods.listSessions.result.safeParse({
        sessions: [session],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      SessionFileStore.methods.listSessions.args.safeParse({ folder: "relative", limit: 20 })
        .success,
    ).toBe(false);
    expect(
      SessionFileStore.methods.readSession.result.safeParse({ ...session, sizeBytes: -1 }).success,
    ).toBe(false);
    expect(
      SessionFileChanged.safeParse({
        folder,
        sessionFile,
        id: threadId,
        kind: "updated",
      }).success,
    ).toBe(true);
    expect(SessionFileChanged.safeParse({ folder, sessionFile, id: threadId }).success).toBe(false);
  });

  test("pin list/set use a revision and reject missing CAS", () => {
    expect(
      SessionPinListResult.safeParse({
        pins: [{ sessionId: threadId, pinned: true, account: "default" }],
        revision,
        readAt: "2026-10-04T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      SessionPinSetArgs.safeParse({
        sessionId: threadId,
        pinned: false,
        expectedRevision: revision,
      }).success,
    ).toBe(true);
    expect(
      SessionPinStore.methods.set.args.safeParse({ sessionId: threadId, pinned: true }).success,
    ).toBe(false);
    expect(
      SessionPinChanged.safeParse({ sessionId: threadId, pinned: true, revision }).success,
    ).toBe(true);
  });
});

describe("A1 ConfigStore", () => {
  test("accepts sourced values and redacted secrets", () => {
    expect(ConfigEntry.safeParse(configValue).success).toBe(true);
    expect(ConfigEntry.safeParse(configSecret).success).toBe(true);
    expect(
      ConfigListResult.safeParse({ entries: [configValue, configSecret], revision }).success,
    ).toBe(true);
    expect(
      ConfigWriteArgs.safeParse({
        key: "provider.apiKey",
        layer: "global",
        value: { secret: true, action: "set", value: "write-only-token" },
        folder: null,
        expectedRevision: null,
      }).success,
    ).toBe(true);
    expect(
      ConfigStore.methods.write.result.safeParse({
        key: "compaction.enabled",
        layer: "project",
        folder,
        revision,
        previousRevision: null,
        entry: configValue,
      }).success,
    ).toBe(true);
    expect(
      ConfigChanged.safeParse({
        key: configValue.key,
        layer: "project",
        folder,
        revision,
        entry: configValue,
      }).success,
    ).toBe(true);
    expect(
      ConfigChanged.safeParse({ key: configValue.key, layer: "project", folder, revision }).success,
    ).toBe(false);
    expect(
      ConfigStore.methods.read.args.safeParse({ key: "compaction.enabled", folder: null }).success,
    ).toBe(true);
    expect(ConfigStore.methods.list.args.safeParse({ prefix: "compaction", folder }).success).toBe(
      true,
    );
    expect(
      ConfigStore.methods.write.args.safeParse({
        key: "compaction.enabled",
        layer: "project",
        value: { secret: false, value: true },
        folder: null,
        expectedRevision: null,
      }).success,
    ).toBe(false);
  });

  test("writes secrets once but never represents them in results or events", () => {
    expect(SecretStatus.safeParse({ ...configSecret, value: "raw-token" }).success).toBe(false);
    expect(ConfigEntry.safeParse({ ...configSecret, value: "raw-token" }).success).toBe(false);
    expect(
      ConfigWriteValue.safeParse({ secret: true, action: "set", value: "raw-token" }).success,
    ).toBe(true);
    expect(ConfigWriteValue.safeParse({ secret: true, action: "unset" }).success).toBe(true);
    expect(ConfigWriteValue.safeParse({ secret: true, isSet: true }).success).toBe(false);
    expect(
      ConfigStore.methods.write.args.safeParse({
        key: "provider.apiKey",
        layer: "global",
        value: { secret: true, action: "set", value: "raw-token" },
        folder: null,
        expectedRevision: null,
      }).success,
    ).toBe(true);
    expect(
      ConfigStore.methods.write.result.safeParse({
        key: "provider.apiKey",
        layer: "global",
        folder: null,
        revision,
        previousRevision: null,
        entry: configSecret,
        value: "raw-token",
      }).success,
    ).toBe(false);
    expect(
      ConfigChanged.safeParse({
        key: "provider.apiKey",
        layer: "global",
        folder: null,
        revision,
        entry: configSecret,
        value: "raw-token",
      }).success,
    ).toBe(false);
  });
});

describe("A1 DraftStore and workspace/git stores", () => {
  test("accepts durable thread drafts and rejects malformed attachment sizes", () => {
    expect(Draft.parse(draft).scope.kind).toBe("thread");
    expect(DraftGetResult.safeParse({ draft }).success).toBe(true);
    expect(
      DraftSaveArgs.safeParse({
        scope: draft.scope,
        draft: { text: draft.text, attachments: draft.attachments, failedSends: draft.failedSends },
        expectedRevision: null,
      }).success,
    ).toBe(true);
    expect(
      DraftStore.methods.save.result.safeParse({
        ...draft,
        attachments: [{ ...draft.attachments[0], sizeBytes: -1 }],
      }).success,
    ).toBe(false);
    expect(DraftChanged.safeParse({ scope: draft.scope, draft }).success).toBe(true);
    expect(DraftChanged.safeParse({ scope: draft.scope }).success).toBe(false);
  });

  test("accepts git and workspace snapshots and rejects negative counts", () => {
    expect(GitState.safeParse(git).success).toBe(true);
    expect(
      WorkspaceState.safeParse({
        folder,
        additionalDirectories: [],
        git,
        observedAt: git.observedAt,
      }).success,
    ).toBe(true);
    expect(
      WorkspaceStatePort.methods.read.result.safeParse({
        folder,
        additionalDirectories: [],
        git,
        observedAt: git.observedAt,
      }).success,
    ).toBe(true);
    expect(GitState.safeParse({ ...git, ahead: -1 }).success).toBe(false);
    expect(GitStatePort.methods.read.result.safeParse(git).success).toBe(true);
  });
});

describe("A1 CheckpointStore", () => {
  test("accepts snapshot/list/diff and restore transaction payloads", () => {
    expect(SnapshotRecord.safeParse(snapshot).success).toBe(true);
    expect(
      CheckpointSnapshotArgs.safeParse({
        workspace: folder,
        conversation,
        source: "manual",
        pinned: false,
      }).success,
    ).toBe(true);
    expect(CheckpointListArgs.safeParse({ workspace: folder, threadId, limit: 100 }).success).toBe(
      true,
    );
    expect(
      CheckpointListResult.safeParse({
        snapshots: [snapshot],
        nextCursor: null,
        pinnedBaseline: snapshot.snapshotId,
      }).success,
    ).toBe(true);
    expect(
      CheckpointDiff.safeParse({
        snapshotId: snapshot.snapshotId,
        workspace: folder,
        entries: [
          {
            path: "src/app.ts",
            change: "modified",
            beforeHash: "sha256:old",
            afterHash: "sha256:new",
            beforeMode: 0o644,
            afterMode: 0o644,
          },
        ],
        excludedPaths: snapshot.excludedPaths,
        externalChanges: [],
        currentWorkspaceHash: revision,
        snapshotWorkspaceHash: "sha256:before",
      }).success,
    ).toBe(true);
    expect(RestorePlan.safeParse(restorePlan).success).toBe(true);
    expect(RestoreResult.safeParse(restoreResult).success).toBe(true);
    expect(RestoreResult.safeParse({ ...restoreResult, capturedPathCount: -1 }).success).toBe(
      false,
    );
    expect(
      CheckpointStore.methods.restore.args.safeParse({
        planId: restorePlan.planId,
        confirmed: true,
      }).success,
    ).toBe(true);
    expect(
      CheckpointStore.methods.restore.args.safeParse({
        planId: restorePlan.planId,
        confirmed: false,
      }).success,
    ).toBe(false);
    expect(
      CheckpointStore.events.changed.payload.safeParse({
        workspace: folder,
        snapshotId: snapshot.snapshotId,
        kind: "created",
      }).success,
    ).toBe(true);
  });
});

describe("A1 OmpCommandGateway", () => {
  test("accepts structured slash-command output and rejects non-slash input", () => {
    expect(CommandRunArgs.safeParse({ threadId, command: "/rename project" }).success).toBe(true);
    expect(
      CommandRunResult.safeParse({
        command: "/rename project",
        status: "completed",
        agentInvoked: false,
        promptSettled: true,
        sessionSettled: true,
        outputs: [{ text: "Renamed" }],
        sessionUpdates: [{ sessionId: threadId, title: "project" }],
        configUpdates: [],
      }).success,
    ).toBe(true);
    expect(
      OmpCommandGateway.methods.run.args.safeParse({ threadId, command: "rename project" }).success,
    ).toBe(false);
    expect(
      OmpCommandGateway.methods.run.result.safeParse({
        command: "/rename project",
        status: "failed",
        agentInvoked: false,
        promptSettled: false,
        sessionSettled: false,
        outputs: [],
        sessionUpdates: [],
        configUpdates: [],
      }).success,
    ).toBe(false);
    expect(CommandOutputEvent.safeParse({ threadId, output: { text: "Renamed" } }).success).toBe(
      true,
    );
  });
});
