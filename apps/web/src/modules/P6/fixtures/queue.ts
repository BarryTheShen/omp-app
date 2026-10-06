import type { OmpWire, RpcSessionEvent } from "@omp-app/contracts";

/**
 * P6's exact inventory boundary. Keep this list explicit so a renamed or newly assigned row breaks
 * the acceptance gate instead of silently disappearing from the registry.
 */
export const P6_INVENTORY_ROWS = [
  "P5.promote-queued-message",
  "P5.queue",
  "P5.remove-queued-message",
  "P5.follow-up-queue-mode",
  "P5.interrupt-mode",
  "P5.steering-queue-mode",
  "P5.queue-mode-selector-component",
  "P5.dequeue-queued-message",
  "P5.follow-up-on-ctrl-enter-ctrl-q",
  "P5.queue-shorthand-and-queued-lists",
  "P5.steer-on-enter-while-streaming",
  "P5.app-message-dequeue",
  "P5.app-message-followup",
  "P5.queued-steering-follow-up-bar",
] as const;

export type P6InventoryId = (typeof P6_INVENTORY_ROWS)[number];

/** Every P6 inventory row names the fixture or descriptor proof that covers it. */
export const P6_FIXTURE_COVERAGE = [
  {
    inventoryId: "P5.promote-queued-message",
    scenario: "queue-mutations",
    proof: "promote-result",
  },
  { inventoryId: "P5.queue", scenario: "queue-composer", proof: "local-queue-command" },
  { inventoryId: "P5.remove-queued-message", scenario: "queue-mutations", proof: "remove-result" },
  {
    inventoryId: "P5.follow-up-queue-mode",
    scenario: "queue-modes",
    proof: "all-and-one-at-a-time",
  },
  { inventoryId: "P5.interrupt-mode", scenario: "queue-modes", proof: "immediate-and-wait" },
  {
    inventoryId: "P5.steering-queue-mode",
    scenario: "queue-modes",
    proof: "all-and-one-at-a-time",
  },
  {
    inventoryId: "P5.queue-mode-selector-component",
    scenario: "queue-modes",
    proof: "session-scoped-selector",
  },
  { inventoryId: "P5.dequeue-queued-message", scenario: "queue-composer", proof: "restore-draft" },
  {
    inventoryId: "P5.follow-up-on-ctrl-enter-ctrl-q",
    scenario: "queue-composer",
    proof: "follow-up-chords",
  },
  {
    inventoryId: "P5.queue-shorthand-and-queued-lists",
    scenario: "queue-composer",
    proof: "shorthand-and-sequential-list",
  },
  {
    inventoryId: "P5.steer-on-enter-while-streaming",
    scenario: "queue-composer",
    proof: "streaming-enter-steer",
  },
  { inventoryId: "P5.app-message-dequeue", scenario: "queue-composer", proof: "alt-up-descriptor" },
  {
    inventoryId: "P5.app-message-followup",
    scenario: "queue-composer",
    proof: "ctrl-enter-descriptor",
  },
  {
    inventoryId: "P5.queued-steering-follow-up-bar",
    scenario: "queue-bar",
    proof: "two-lane-authoritative-snapshot",
  },
] as const satisfies ReadonlyArray<{
  readonly inventoryId: P6InventoryId;
  readonly scenario:
    | "queue-mutations"
    | "queue-composer"
    | "queue-modes"
    | "queue-bar"
    | "descriptor-audit";
  readonly proof: string;
}>;

/**
 * The fields below are the real `get_state` queue projection. The wire's queuedMessages member is
 * intentionally kept as `{ steering: string[]; followUp: string[] }`, not an app-specific item
 * object. Evidence: `.data/ref/omp-v18.6.1/docs_rpc.md:384-449` and
 * `packages/contracts/src/omp-wire/rpc-wire.generated.ts:417-421,456-477`.
 */
export type P6GetStateFixture = Pick<
  OmpWire.SessionState,
  | "sessionId"
  | "isStreaming"
  | "isSettled"
  | "steeringMode"
  | "followUpMode"
  | "interruptMode"
  | "queuedMessages"
>;

/** A normalized R0 fixture has the same event payload omp emits on its wire. */
export interface P6QueueFixture {
  readonly getState: P6GetStateFixture;
  readonly queueUpdates: readonly OmpWire.QueueUpdateEvent[];
}

export const P6_GET_STATE_STREAMING: P6GetStateFixture = {
  sessionId: "p6-fixture-session",
  isStreaming: true,
  isSettled: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  queuedMessages: {
    steering: ["steer the running turn"],
    followUp: ["summarize after yield"],
  },
};

export const P6_QUEUE_UPDATE_STREAMING: OmpWire.QueueUpdateEvent = {
  type: "queue_update",
  steering: ["steer the running turn"],
  followUp: ["summarize after yield"],
};

export const P6_GET_STATE_DUPLICATE_TEXT: P6GetStateFixture = {
  ...P6_GET_STATE_STREAMING,
  queuedMessages: {
    steering: ["same text", "same text"],
    followUp: ["same text"],
  },
};

export const P6_QUEUE_UPDATE_DUPLICATE_TEXT: OmpWire.QueueUpdateEvent = {
  type: "queue_update",
  steering: ["same text", "same text"],
  followUp: ["same text"],
};

export const P6_GET_STATE_AFTER_YIELD: P6GetStateFixture = {
  sessionId: "p6-fixture-session",
  isStreaming: false,
  isSettled: false,
  steeringMode: "one-at-a-time",
  followUpMode: "all",
  interruptMode: "wait",
  queuedMessages: {
    steering: [],
    followUp: ["wake the next turn"],
  },
};

export const P6_QUEUE_UPDATE_AFTER_YIELD: OmpWire.QueueUpdateEvent = {
  type: "queue_update",
  steering: [],
  followUp: ["wake the next turn"],
};

export const P6_GET_STATE_RECONNECTED: P6GetStateFixture = {
  sessionId: "p6-fixture-session",
  isStreaming: true,
  isSettled: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "wait",
  queuedMessages: {
    steering: ["authoritative after reconnect"],
    followUp: [],
  },
};

export const P6_QUEUE_UPDATE_RECONNECTED: OmpWire.QueueUpdateEvent = {
  type: "queue_update",
  steering: ["authoritative after reconnect"],
  followUp: [],
};

/**
 * Scrubbed synthetic queue scenarios consumed by the P6/R0 gate. Duplicate events are intentional:
 * queue_update is a coalesced snapshot, so replaying the same payload must never append another
 * queue item. Evidence for that event shape: `.data/ref/omp-v18.6.1/docs_rpc.md:732-751` and
 * `packages/contracts/src/omp-wire/rpc-wire.generated.ts:895-900`.
 */

/** A queue clear is a new authoritative snapshot, not a local P6 array mutation. */
export const P6_GET_STATE_CLEARED: P6GetStateFixture = {
  ...P6_GET_STATE_STREAMING,
  isStreaming: false,
  isSettled: true,
  queuedMessages: { steering: [], followUp: [] },
};

export const P6_QUEUE_UPDATE_CLEARED: OmpWire.QueueUpdateEvent = {
  type: "queue_update",
  steering: [],
  followUp: [],
};

export const P6_QUEUE_FIXTURES = {
  streaming: {
    getState: P6_GET_STATE_STREAMING,
    queueUpdates: [P6_QUEUE_UPDATE_STREAMING],
  },
  duplicate: {
    getState: P6_GET_STATE_DUPLICATE_TEXT,
    queueUpdates: [P6_QUEUE_UPDATE_DUPLICATE_TEXT, P6_QUEUE_UPDATE_DUPLICATE_TEXT],
  },
  afterYield: {
    getState: P6_GET_STATE_AFTER_YIELD,
    queueUpdates: [P6_QUEUE_UPDATE_AFTER_YIELD],
  },
  reconnected: {
    getState: P6_GET_STATE_RECONNECTED,
    queueUpdates: [P6_QUEUE_UPDATE_RECONNECTED],
  },
  cleared: {
    getState: P6_GET_STATE_CLEARED,
    queueUpdates: [P6_QUEUE_UPDATE_CLEARED],
  },
} as const satisfies Readonly<Record<string, P6QueueFixture>>;

/** omp returns booleans for remove/promote; false is an ordinary stale-chip no-op. */
export const P6_MUTATION_FIXTURES = {
  removeAccepted: { removed: true } satisfies OmpWire.RemoveQueuedMessageResult,
  removeStale: { removed: false } satisfies OmpWire.RemoveQueuedMessageResult,
  promoteAccepted: { promoted: true } satisfies OmpWire.PromoteQueuedMessageResult,
  promoteStale: { promoted: false } satisfies OmpWire.PromoteQueuedMessageResult,
} as const;

/** Queue admission retains images on the typed intent even though queue_update carries text chips. */
export const P6_ATTACHMENT_ADMISSION_FIXTURE = {
  text: "inspect the attached image",
  images: [
    {
      type: "image",
      data: "data:image/png;base64,fixture",
      mimeType: "image/png",
      url: "data:image/png;base64,fixture",
    },
  ],
} as const;

/** The two lifecycle events are separate in omp: yield first, quiescence only when settled. */
export const P6_PROMPT_RESULT_FIXTURE: RpcSessionEvent = {
  kind: "prompt_result",
  event: {
    type: "prompt_result",
    agentInvoked: true,
    status: "completed",
    sessionSettled: false,
    id: "prompt-result-1",
  },
};

export const P6_SESSION_SETTLED_FIXTURE: RpcSessionEvent = {
  kind: "session_settled",
  event: { type: "session_settled" },
};
