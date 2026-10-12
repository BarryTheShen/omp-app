import type { OmpWire } from "@omp-app/contracts";
import type { RuntimeSnapshot } from "../../R0/store/store";

/** F5 and C6 are the composer/input groups assigned to U2 in modules/U2/README.md. */
export const U2_INVENTORY_ROWS = [
  "F5.history-search",
  "F5.history-search-picker",
  "F5.external-editor",
  "F5.history-navigation",
  "F5.image-paste-and-image-chips",
  "F5.large-text-paste-handling",
  "F5.prompt-editor-core",
  "F5.app-clipboard-copyline",
  "F5.app-clipboard-copyprompt",
  "F5.app-clipboard-pasteimage",
  "F5.app-clipboard-pastetextraw",
  "F5.app-history-search",
  "F5.tui-editor-cursordown",
  "F5.tui-editor-cursorleft",
  "F5.tui-editor-cursorlineend",
  "F5.tui-editor-cursorlinestart",
  "F5.tui-editor-cursorright",
  "F5.tui-editor-cursorup",
  "F5.tui-editor-cursorwordleft",
  "F5.tui-editor-cursorwordright",
  "F5.tui-editor-deletecharbackward",
  "F5.tui-editor-deletecharforward",
  "F5.tui-editor-deletetolineend",
  "F5.tui-editor-deletetolinestart",
  "F5.tui-editor-deletewordbackward",
  "F5.tui-editor-deletewordforward",
  "F5.tui-editor-jumpbackward",
  "F5.tui-editor-jumpforward",
  "F5.tui-editor-pagedown",
  "F5.tui-editor-pageup",
  "F5.tui-editor-undo",
  "F5.tui-editor-yank",
  "F5.tui-editor-yankpop",
  "F5.tui-input-copy",
  "F5.tui-input-newline",
  "F5.tui-input-submit",
  "F5.tui-input-tab",
  "C6.python-composer-mode",
  "C6.bash-composer-mode",
  "C6.user-python-execution",
  "C6.user-bash-execution",
] as const;

export type U2InventoryId = (typeof U2_INVENTORY_ROWS)[number];
export type U2FixtureId = "idle" | "streaming";

export const U2_FIXTURE_COVERAGE = [
  { inventoryId: "F5.history-search", fixture: "idle", proof: "history-search-entry" },
  { inventoryId: "F5.history-search-picker", fixture: "idle", proof: "history-search-picker" },
  { inventoryId: "F5.external-editor", fixture: "idle", proof: "external-editor-shortcut" },
  { inventoryId: "F5.history-navigation", fixture: "idle", proof: "history-navigation" },
  {
    inventoryId: "F5.image-paste-and-image-chips",
    fixture: "idle",
    proof: "image-attachment-submit",
  },
  { inventoryId: "F5.large-text-paste-handling", fixture: "idle", proof: "large-paste-attachment" },
  { inventoryId: "F5.prompt-editor-core", fixture: "idle", proof: "composer-text-submit" },
  { inventoryId: "F5.app-clipboard-copyline", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.app-clipboard-copyprompt", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.app-clipboard-pasteimage", fixture: "idle", proof: "image-attachment-submit" },
  { inventoryId: "F5.app-clipboard-pastetextraw", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.app-history-search", fixture: "idle", proof: "history-search-shortcut" },
  { inventoryId: "F5.tui-editor-cursordown", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-cursorleft", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-cursorlineend", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-cursorlinestart", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-cursorright", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-cursorup", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-cursorwordleft", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-cursorwordright", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-deletecharbackward", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-deletecharforward", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-deletetolineend", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-deletetolinestart", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-deletewordbackward", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-deletewordforward", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-jumpbackward", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-jumpforward", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-pagedown", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-pageup", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-undo", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-yank", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-editor-yankpop", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-input-copy", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "F5.tui-input-newline", fixture: "idle", proof: "multiline-enter-policy" },
  { inventoryId: "F5.tui-input-submit", fixture: "idle", proof: "composer-text-submit" },
  { inventoryId: "F5.tui-input-tab", fixture: "idle", proof: "editor-keyboard" },
  { inventoryId: "C6.python-composer-mode", fixture: "streaming", proof: "python-capability-gate" },
  { inventoryId: "C6.bash-composer-mode", fixture: "idle", proof: "bash-mode-handoff" },
  { inventoryId: "C6.user-python-execution", fixture: "streaming", proof: "execution-row-shape" },
  { inventoryId: "C6.user-bash-execution", fixture: "idle", proof: "bash-mode-handoff" },
] as const satisfies readonly {
  readonly inventoryId: U2InventoryId;
  readonly fixture: U2FixtureId;
  readonly proof: string;
}[];

export interface U2StateFixture {
  readonly format: "omp-app.u2-normalized-fixture";
  readonly formatVersion: 1;
  readonly scenario: string;
  readonly source: "scripted";
  readonly omp: {
    readonly version: "18.6.1";
    readonly commit: "2a2c6dcbbb558c0f8145f67f28b3370984f2bf60";
    readonly protocolVersion: 2;
    readonly mode: "rpc-ui";
  };
  readonly provider: { readonly kind: "fake-openai" };
  readonly placeholders: readonly ["<WORKSPACE>"];
  readonly redactions: {
    readonly key: 0;
    readonly token: 0;
    readonly authHeader: 0;
    readonly email: 0;
    readonly path: 0;
  };
  readonly inventory: typeof U2_INVENTORY_ROWS;
  /** The scripted get_state result and its exact R0 projection used by the composer. */
  readonly getState: OmpWire.SessionState;
  readonly snapshot: Pick<RuntimeSnapshot, "process" | "prompt" | "queue" | "session">;
}

const model = {
  id: "fake-model",
  name: "Fake Model",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "http://fake-openai.invalid/v1",
  reasoning: true,
  thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
} satisfies OmpWire.ModelInfo;

const sharedSessionState = {
  sessionId: "u2-scripted-session",
  model,
  thinkingLevel: "high",
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  sessionFile: "<WORKSPACE>/.omp/agent/sessions/u2-scripted-session.jsonl",
  sessionName: "Composer acceptance",
  autoCompactionEnabled: true,
  queuedMessageCount: 0,
  hasPendingAsyncWork: false,
  todoPhases: [],
  fastModeEnabled: false,
  tokensPerSecond: null,
  fastModeActive: false,
  messageCount: 0,
  contextUsage: { tokens: 6_567, contextWindow: 128_000, percent: 5.13 },
  goal: null,
} satisfies Omit<OmpWire.SessionState, "isStreaming" | "isSettled" | "queuedMessages">;

function snapshotProjection(input: {
  readonly streaming: boolean;
  readonly settled: boolean;
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}): Pick<RuntimeSnapshot, "process" | "prompt" | "queue" | "session"> {
  return {
    process: { status: "ready", error: null },
    prompt: {
      admitted: input.streaming,
      streaming: input.streaming,
      promptResult: null,
      sessionSettled: input.settled,
      promptResults: [],
    },
    queue: {
      steering: [...input.steering],
      followUp: [...input.followUp],
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      interruptMode: "immediate",
      liveSteered: 0,
    },
    session: {
      model,
      thinkingLevel: "high",
      sessionName: "Composer acceptance",
      contextUsage: { tokens: 6_567, contextWindow: 128_000, percent: 5.13 },
      isCompacting: false,
      autoCompactionEnabled: true,
      tokensPerSecond: null,
      goal: null,
      revision: 1,
    },
  };
}

const commonMetadata = {
  format: "omp-app.u2-normalized-fixture",
  formatVersion: 1,
  source: "scripted",
  omp: {
    version: "18.6.1",
    commit: "2a2c6dcbbb558c0f8145f67f28b3370984f2bf60",
    protocolVersion: 2,
    mode: "rpc-ui",
  },
  provider: { kind: "fake-openai" },
  placeholders: ["<WORKSPACE>"],
  redactions: { key: 0, token: 0, authHeader: 0, email: 0, path: 0 },
  inventory: U2_INVENTORY_ROWS,
} as const;

/**
 * Wire shape follows omp v18.6.1 `get_state` in
 * `packages/coding-agent/src/modes/rpc/rpc-mode.ts:1871-1902`; values are scripted. R0's
 * `applySessionState` projection is stored alongside it so acceptance tests exercise the same
 * normalized session, prompt and queue state consumed by the composer.
 */
export const U2_STATE_FIXTURES = {
  idle: {
    ...commonMetadata,
    scenario: "composer-idle",
    getState: {
      ...sharedSessionState,
      isStreaming: false,
      isSettled: true,
      queuedMessages: { steering: [], followUp: [] },
    },
    snapshot: snapshotProjection({ streaming: false, settled: true, steering: [], followUp: [] }),
  },
  streaming: {
    ...commonMetadata,
    scenario: "composer-streaming",
    getState: {
      ...sharedSessionState,
      isStreaming: true,
      isSettled: false,
      queuedMessageCount: 2,
      queuedMessages: { steering: ["check the failing assertion"], followUp: ["run tests"] },
    },
    snapshot: snapshotProjection({
      streaming: true,
      settled: false,
      steering: ["check the failing assertion"],
      followUp: ["run tests"],
    }),
  },
} as const satisfies Readonly<Record<U2FixtureId, U2StateFixture>>;
