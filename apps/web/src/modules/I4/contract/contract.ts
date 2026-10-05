import type { AppError, CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import { AppError as AppErrorSchema } from "@omp-app/contracts";
import { z } from "zod";

/** AP6 capability: v18.6.1 has no authoritative collaboration RPC or event stream. */
export const COLLABORATION_CAPABILITY = "upstream.collaboration" as CapabilityKey;
export const COLLABORATION_UNAVAILABLE_REASON =
  "No app relay; collaboration requires omp's own upstream RPC.";
export const COLLABORATION_COMMAND_CAPABILITIES = {
  start: COLLABORATION_CAPABILITY,
  join: COLLABORATION_CAPABILITY,
  leave: COLLABORATION_CAPABILITY,
  stop: COLLABORATION_CAPABILITY,
  status: COLLABORATION_CAPABILITY,
} as const;

export const CollaborationRoleSchema = z.enum(["host", "guest", "viewer"]);
export type CollaborationRole = z.infer<typeof CollaborationRoleSchema>;

export const ParticipantPresenceSchema = z.enum(["active", "disconnected", "left"]);
export type ParticipantPresence = z.infer<typeof ParticipantPresenceSchema>;

/** Authoritative participant state arrives only from AP6; the app never derives it from a tab. */
export const ParticipantStateSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  role: CollaborationRoleSchema,
  presence: ParticipantPresenceSchema,
  readOnly: z.boolean(),
  joinedAt: z.number().finite().nonnegative().optional(),
});
export type ParticipantState = z.infer<typeof ParticipantStateSchema>;

export const CollaborationPhaseSchema = z.enum([
  "unavailable",
  "idle",
  "connecting",
  "hosting",
  "joined",
  "stopping",
  "stopped",
  "disconnected",
  "error",
]);
export type CollaborationPhase = z.infer<typeof CollaborationPhaseSchema>;

export const CollaborationCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("collab_start"),
    mode: z.enum(["host", "view"]),
    relayUrl: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal("collab_join"), link: z.string().min(1) }),
  z.strictObject({ type: z.literal("collab_leave") }),
  z.strictObject({ type: z.literal("collab_stop") }),
  z.strictObject({ type: z.literal("collab_status") }),
]);
export type CollaborationCommand = z.infer<typeof CollaborationCommandSchema>;

export const CollaborationStartResultSchema = z.strictObject({
  sessionId: z.string().min(1),
  role: z.enum(["host", "viewer"]),
  link: z.string().min(1).optional(),
});
export type CollaborationStartResult = z.infer<typeof CollaborationStartResultSchema>;

export const CollaborationJoinResultSchema = z.strictObject({
  sessionId: z.string().min(1),
  role: z.enum(["guest", "viewer"]),
});
export type CollaborationJoinResult = z.infer<typeof CollaborationJoinResultSchema>;

export const CollaborationLeaveResultSchema = z.strictObject({
  stopped: z.boolean(),
});
export type CollaborationLeaveResult = z.infer<typeof CollaborationLeaveResultSchema>;

export const CollaborationStopResultSchema = z.strictObject({
  stopped: z.boolean(),
});
export type CollaborationStopResult = z.infer<typeof CollaborationStopResultSchema>;

export const CollaborationStatusResultSchema = z.strictObject({
  sessionId: z.string().min(1).optional(),
  role: CollaborationRoleSchema,
  participants: z.array(ParticipantStateSchema),
  readOnly: z.boolean(),
});
export type CollaborationStatusResult = z.infer<typeof CollaborationStatusResultSchema>;

export const CollaborationGuestPromptSchema = z.strictObject({
  sessionId: z.string().min(1),
  participantId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string(),
  timestamp: z.number().finite().nonnegative(),
});
export type CollaborationGuestPrompt = z.infer<typeof CollaborationGuestPromptSchema>;

export const CollaborationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("collab_phase"),
    phase: CollaborationPhaseSchema,
    sessionId: z.string().min(1).optional(),
    role: CollaborationRoleSchema.optional(),
    link: z.string().min(1).optional(),
    readOnly: z.boolean(),
    error: AppErrorSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("collab_participant"),
    participant: ParticipantStateSchema,
  }),
  z.strictObject({
    type: z.literal("collab_guest_prompt"),
    prompt: CollaborationGuestPromptSchema,
  }),
  z.strictObject({
    type: z.literal("collab_end"),
    sessionId: z.string().min(1),
    reason: z.enum(["left", "stopped", "disconnected", "error"]),
  }),
]);
export type CollaborationEvent = z.infer<typeof CollaborationEventSchema>;

export const ReadOnlySessionPhaseSchema = z.enum([
  "unavailable",
  "idle",
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type ReadOnlySessionPhase = z.infer<typeof ReadOnlySessionPhaseSchema>;

export const ReadOnlySessionSnapshotSchema = z.strictObject({
  phase: ReadOnlySessionPhaseSchema,
  sessionId: z.string().min(1).optional(),
  participants: z.array(ParticipantStateSchema),
  readOnly: z.literal(true),
  unavailableReason: z.string().min(1).optional(),
});
export type ReadOnlySessionSnapshot = z.infer<typeof ReadOnlySessionSnapshotSchema>;

export interface ReadOnlySessionPort {
  getSnapshot(): ReadOnlySessionSnapshot;
  subscribe(listener: (snapshot: ReadOnlySessionSnapshot) => void): () => void;
}

export type CollaborationResult<T> =
  | { readonly state: "available"; readonly value: T }
  | { readonly state: "unavailable"; readonly error: AppError };

export interface CollaborationPort {
  readonly capabilities: CapabilityMap;
  readonly readOnlySession: ReadOnlySessionPort;
  createView(options?: {
    readonly relayUrl?: string;
    readonly displayName?: string;
  }): Promise<CollaborationResult<CollaborationStartResult>>;
  join(link: string): Promise<CollaborationResult<CollaborationJoinResult>>;
  leave(): Promise<CollaborationResult<CollaborationLeaveResult>>;
  stop(): Promise<CollaborationResult<CollaborationStopResult>>;
  status(): Promise<CollaborationResult<CollaborationStatusResult>>;
  subscribe(listener: (event: CollaborationEvent) => void): () => void;
}

function unavailableError(
  capability: CapabilityKey,
  reason = COLLABORATION_UNAVAILABLE_REASON,
): AppError {
  return {
    code: "unavailable",
    message: reason,
    retryable: false,
    capability,
  };
}

function unavailable<T>(capability: CapabilityKey): CollaborationResult<T> {
  return { state: "unavailable", error: unavailableError(capability) };
}

/**
 * Current v18.6.1 adapter: every operation is visibly unavailable until AP6's typed upstream
 * command/event contract is reported. No browser tab or app relay is treated as collaboration.
 */
export function createUnavailableCollaborationPort(
  capabilities: CapabilityMap = {},
): CollaborationPort {
  const snapshot: ReadOnlySessionSnapshot = {
    phase: "unavailable",
    participants: [],
    readOnly: true,
    unavailableReason: COLLABORATION_UNAVAILABLE_REASON,
  };
  const readOnlySession: ReadOnlySessionPort = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  };
  return {
    capabilities,
    readOnlySession,
    createView: () =>
      Promise.resolve(unavailable<CollaborationStartResult>(COLLABORATION_CAPABILITY)),
    join: () => Promise.resolve(unavailable<CollaborationJoinResult>(COLLABORATION_CAPABILITY)),
    leave: () => Promise.resolve(unavailable<CollaborationLeaveResult>(COLLABORATION_CAPABILITY)),
    stop: () => Promise.resolve(unavailable<CollaborationStopResult>(COLLABORATION_CAPABILITY)),
    status: () => Promise.resolve(unavailable<CollaborationStatusResult>(COLLABORATION_CAPABILITY)),
    subscribe: () => () => undefined,
  };
}
