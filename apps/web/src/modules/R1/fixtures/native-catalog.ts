import type {
  CapabilityMap,
  GitState,
  OmpWire,
  SessionFile,
  SessionImportResult,
  SessionPinListResult,
  WorkspaceState,
} from "@omp-app/contracts";
import {
  FolderPath as FolderPathSchema,
  SessionFilePath,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";

/**
 * The inventory group R1 owns. Keep this list explicit: the descriptor audit must fail when omp
 * adds, removes, or renames one of the fourteen rows assigned to this module.
 *
 * Shape evidence: `research/modules/R1.md:5-18` and the A1 metadata contract at
 * `packages/contracts/src/ports/A1/session-file-store.ts:35-55`.
 */
export const R1_INVENTORY_ROWS = [
  "F3.open-session",
  "D2.resume",
  "D2.session-delete-confirmation",
  "D2.session-pin-account-selector",
  "D2.session-selector",
  "D2.app-session-delete",
  "D2.app-session-deletenoninvasive",
  "D2.app-session-fork",
  "D2.app-session-new",
  "D2.app-session-observe",
  "D2.app-session-rename",
  "D2.app-session-resume",
  "D2.app-session-togglepath",
  "D2.app-session-togglesort",
] as const;

export type R1InventoryId = (typeof R1_INVENTORY_ROWS)[number];

/** Every inventory row points at a concrete fixture, a chord proof, or is recorded as not offered. */
export const R1_FIXTURE_COVERAGE = [
  { inventoryId: "F3.open-session", scenario: "native-catalog-w3", proof: "open-handoff" },
  { inventoryId: "D2.resume", scenario: "native-catalog-w3", proof: "sidebar-resume" },
  {
    inventoryId: "D2.session-delete-confirmation",
    scenario: "native-catalog-w3",
    proof: "typed-delete-confirmation",
  },
  {
    inventoryId: "D2.session-pin-account-selector",
    scenario: "native-catalog-w3",
    proof: "typed-pin-cas",
  },
  { inventoryId: "D2.session-selector", scenario: "native-catalog-w3", proof: "sidebar-selector" },
  {
    inventoryId: "D2.app-session-delete",
    scenario: "descriptor-audit",
    proof: "shortcut-descriptor",
  },
  {
    inventoryId: "D2.app-session-deletenoninvasive",
    scenario: "descriptor-audit",
    proof: "shortcut-descriptor",
  },
  {
    inventoryId: "D2.app-session-fork",
    scenario: "not-offered",
    proof: "the session list has no fork action",
  },
  {
    inventoryId: "D2.app-session-new",
    scenario: "native-catalog-w3",
    proof: "new-session-handoff",
  },
  {
    inventoryId: "D2.app-session-observe",
    scenario: "not-offered",
    proof: "the app has no observe view",
  },
  {
    inventoryId: "D2.app-session-rename",
    scenario: "native-catalog-w3",
    proof: "typed-rename",
  },
  {
    inventoryId: "D2.app-session-resume",
    scenario: "native-catalog-w3",
    proof: "sidebar-resume",
  },
  {
    inventoryId: "D2.app-session-togglepath",
    scenario: "not-offered",
    proof: "the session list shows no path to toggle",
  },
  {
    inventoryId: "D2.app-session-togglesort",
    scenario: "not-offered",
    proof: "the session list has no sort order to toggle",
  },
] as const satisfies ReadonlyArray<{
  readonly inventoryId: R1InventoryId;
  readonly scenario: "native-catalog-w3" | "descriptor-audit" | "not-offered";
  readonly proof: string;
}>;

export const R1_FIXTURE_FOLDER = FolderPathSchema.parse("/workspace/omp-repo/app");
export const R1_FIXTURE_REPOSITORY = FolderPathSchema.parse("/workspace/omp-repo");
export const R1_FIXTURE_WORKTREE = FolderPathSchema.parse("/workspace/omp-feature");
export const R1_FIXTURE_UNRELATED = FolderPathSchema.parse("/workspace/other");

export const R1_THREAD_IDS = {
  active: ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-111111111111"),
  warning: ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-222222222222"),
  untitled: ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-333333333333"),
  worktree: ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-444444444444"),
  repository: ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-555555555555"),
  unrelated: ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-666666666666"),
  imported: ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-777777777777"),
} as const;

function sessionFile(id: string): SessionFile["sessionFile"] {
  return SessionFilePath.parse(
    `/workspace/.omp/agent/sessions/<WORKSPACE_BUCKET>/2026-10-05T12-00-00.000Z_${id}.jsonl`,
  );
}

function childSessionFile(id: string): SessionFile["sessionFile"] {
  return SessionFilePath.parse(
    `/workspace/.omp/agent/sessions/<WORKSPACE_BUCKET>/2026-10-05T12-00-01.000Z_${id}.jsonl`,
  );
}

/**
 * Native omp session headers as returned by A1. The v1 row has no title, the v3 row has a parser
 * warning, and the active row has a held lease plus a child transcript; these are the fields the
 * catalog/sidebar must display without reading JSONL in the browser.
 */
export const R1_NATIVE_SESSION_FILES: readonly SessionFile[] = Object.freeze([
  {
    id: R1_THREAD_IDS.active,
    sessionFile: sessionFile(R1_THREAD_IDS.active),
    version: 3,
    title: "Catalog stream",
    displayTitle: "Catalog stream",
    firstPrompt: "List the sessions in this folder",
    cwd: R1_FIXTURE_FOLDER,
    createdAt: "2026-10-05T11:45:00.000Z",
    updatedAt: "2026-10-05T12:00:00.000Z",
    parentSession: null,
    messageCount: 4,
    assistantTurns: 2,
    sizeBytes: 4_812,
    status: "pending",
    liveness: { lease: "held", serverProcess: true },
    subagents: [
      {
        key: "worker-1",
        agentId: "agent-1",
        parent: null,
        sessionFile: childSessionFile("agent-1"),
        leafId: null,
        entryCount: 2,
        aborted: false,
        status: "unknown",
        endedAt: null,
        agent: null,
      },
    ],
    parseWarnings: [],
  },
  {
    id: R1_THREAD_IDS.warning,
    sessionFile: sessionFile(R1_THREAD_IDS.warning),
    version: 3,
    title: "Needs review",
    displayTitle: "Needs review",
    firstPrompt: "Inspect the parser audit",
    cwd: R1_FIXTURE_FOLDER,
    createdAt: "2026-10-05T11:30:00.000Z",
    updatedAt: "2026-10-05T11:58:00.000Z",
    parentSession: null,
    messageCount: 6,
    assistantTurns: 3,
    sizeBytes: 6_144,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: ["legacy title slot was ignored"],
  },
  {
    id: R1_THREAD_IDS.untitled,
    sessionFile: sessionFile(R1_THREAD_IDS.untitled),
    version: 1,
    title: null,
    displayTitle: null,
    firstPrompt: "Resume the parser audit",
    cwd: R1_FIXTURE_FOLDER,
    createdAt: "2026-10-05T11:00:00.000Z",
    updatedAt: "2026-10-05T11:56:00.000Z",
    parentSession: null,
    messageCount: 2,
    assistantTurns: 1,
    sizeBytes: 1_920,
    status: "interrupted",
    liveness: { lease: "unknown", serverProcess: false },
    subagents: [],
    parseWarnings: [],
  },
  {
    id: R1_THREAD_IDS.worktree,
    sessionFile: sessionFile(R1_THREAD_IDS.worktree),
    version: 3,
    title: "Feature worktree",
    displayTitle: "Feature worktree",
    firstPrompt: "Review the worktree changes",
    cwd: R1_FIXTURE_WORKTREE,
    createdAt: "2026-10-05T11:40:00.000Z",
    updatedAt: "2026-10-05T11:59:00.000Z",
    parentSession: null,
    messageCount: 3,
    assistantTurns: 1,
    sizeBytes: 3_072,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
  },
  {
    id: R1_THREAD_IDS.repository,
    sessionFile: sessionFile(R1_THREAD_IDS.repository),
    version: 2,
    title: "Repository root",
    displayTitle: "Repository root",
    firstPrompt: "Check the repository root",
    cwd: R1_FIXTURE_REPOSITORY,
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T11:50:00.000Z",
    parentSession: null,
    messageCount: 1,
    assistantTurns: 0,
    sizeBytes: 768,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
  },
  {
    id: R1_THREAD_IDS.unrelated,
    sessionFile: sessionFile(R1_THREAD_IDS.unrelated),
    version: 3,
    title: "Unrelated project",
    displayTitle: "Unrelated project",
    firstPrompt: "Do not show this session",
    cwd: R1_FIXTURE_UNRELATED,
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T11:59:00.000Z",
    parentSession: null,
    messageCount: 1,
    assistantTurns: 0,
    sizeBytes: 512,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
  },
]);

export const R1_PIN_LIST: SessionPinListResult = {
  pins: [{ sessionId: R1_THREAD_IDS.warning, pinned: true }],
  revision: "pins-r7",
  readAt: "2026-10-05T12:00:02.000Z",
};

const R1_GIT_STATE: GitState = {
  repositoryRoot: R1_FIXTURE_REPOSITORY,
  branch: "main",
  head: "a1b2c3d4",
  detached: false,
  dirtyFiles: [],
  ahead: 0,
  behind: 0,
  worktrees: [
    {
      path: R1_FIXTURE_WORKTREE,
      head: "d4c3b2a1",
      branch: "feature/catalog",
      detached: false,
      bare: false,
      locked: false,
    },
  ],
  observedAt: "2026-10-05T12:00:02.000Z",
};

export const R1_WORKSPACE_STATE: WorkspaceState = {
  folder: R1_FIXTURE_FOLDER,
  additionalDirectories: [],
  git: R1_GIT_STATE,
  observedAt: "2026-10-05T12:00:02.000Z",
};

export const R1_OPEN_CAPABILITIES: CapabilityMap = {
  "omp.cmd.open_session": { state: "available", via: "rpc" },
  "omp.cmd.get_state": { state: "available", via: "rpc" },
  "omp.cmd.get_entries": { state: "available", via: "rpc" },
  "omp.cmd.get_tree": { state: "available", via: "rpc" },
  "omp.cmd.set_session_name": { state: "available", via: "rpc" },
  "host.session-files": { state: "available", via: "host" },
  "host.session-pins": { state: "available", via: "host" },
  "host.command-gateway": { state: "available", via: "host" },
};

const historyUserEntry = {
  type: "message",
  id: "entry-user-1",
  parentId: null,
  timestamp: "2026-10-05T11:45:00.000Z",
  message: {
    role: "user",
    content: [{ type: "text", text: "List the sessions in this folder" }],
    attribution: "user",
    timestamp: 1791200700000,
  },
};

const historyAssistantEntry = {
  type: "message",
  id: "entry-assistant-1",
  parentId: "entry-user-1",
  timestamp: "2026-10-05T11:45:05.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "I found the native session catalog." }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage: {
      input: 18,
      output: 9,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 27,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1791200705000,
    responseId: "chatcmpl-catalog-fixture",
  },
};

/** Persisted entries in the shape returned by omp get_entries. */
export const R1_HISTORY_ENTRIES: readonly Record<string, unknown>[] = Object.freeze([
  historyUserEntry,
  historyAssistantEntry,
]);

export const R1_HISTORY_STATE: OmpWire.SessionState = {
  sessionId: R1_THREAD_IDS.active,
  model: {
    id: "fake-model",
    name: "Fixture Model",
    api: "openai-completions",
    provider: "fake",
    baseUrl: "http://fake.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinking: { mode: "enabled", efforts: ["low", "medium", "high"], defaultLevel: "medium" },
  },
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  sessionName: "Catalog stream",
  autoCompactionEnabled: true,
  tokensPerSecond: 42,
  isSettled: true,
  contextUsage: { tokens: 2_048, contextWindow: 128_000, percent: 1.6 },
  queuedMessages: { steering: [], followUp: [] },
  goal: null,
};

export const R1_IMPORT_RESULT: SessionImportResult = {
  threadId: R1_THREAD_IDS.imported,
  sessionFile: sessionFile(R1_THREAD_IDS.imported),
  title: "Imported Claude session",
  sourceKind: "claude",
  artifactStatus: "preserved",
  artifactWarnings: [],
};

export const R1_REPLAY_SCENARIO = "prompt-stream" as const;
