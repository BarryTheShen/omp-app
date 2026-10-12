import type { CapabilityKey, SessionFilePath, ThreadId } from "@omp-app/contracts";
import {
  AppError as AppErrorSchema,
  CapabilityKey as CapabilityKeySchema,
  EntryId,
  FolderPath,
  Revision,
  SessionFilePath as SessionFilePathSchema,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { z } from "zod";
import type { SessionInfoState } from "../../R0/store";

/** D5 command names; lifecycle execution is owned by the later D5 parts. */
export const SessionCommand = z.enum(["info", "rename", "pin", "delete", "new", "clear", "fresh"]);
export type SessionCommand = z.infer<typeof SessionCommand>;
export type SessionActionCommand = Exclude<SessionCommand, "new" | "clear" | "fresh">;

export const SessionRenameRequest = z.strictObject({
  title: z.string().trim().min(1).max(200),
});
export type SessionRenameRequest = z.infer<typeof SessionRenameRequest>;

export const SessionPinRequest = z.strictObject({
  pinned: z.boolean(),
  expectedRevision: Revision.nullable(),
});
export type SessionPinRequest = z.infer<typeof SessionPinRequest>;

export const SessionDeleteRequest = z.strictObject({
  confirmationId: z.string().min(1).optional(),
});
export type SessionDeleteRequest = z.infer<typeof SessionDeleteRequest>;

/** The identity/path fields R1 can provide for the selected native session. */
export const SessionInfoMetadata = z.strictObject({
  id: ThreadIdSchema,
  title: z.string().nullable(),
  /** The title's own words, without omp's card icon and code; null for an untitled chat. */
  displayTitle: z.string().nullable(),
  cwd: FolderPath.nullable(),
  sessionFile: SessionFilePathSchema.nullable(),
});
export type SessionInfoMetadata = z.infer<typeof SessionInfoMetadata>;

/**
 * Browser session information. `session` is the exact R0 projection of omp `get_state`; D5 does
 * not maintain another session-state reducer. The scalar metadata fields are kept separate from
 * it because R0 intentionally does not own the catalog's cwd/session-file metadata.
 *
 * R0 source: apps/web/src/modules/R0/store/store.ts:149-159,186. The underlying omp shape is
 * packages/contracts/src/omp-wire/rpc-wire.generated.ts:456-484.
 */
export interface SessionInfoSnapshot {
  readonly id: ThreadId;
  readonly title: string | null;
  readonly cwd: SessionInfoMetadata["cwd"];
  readonly sessionFile: SessionFilePath | null;
  readonly session: SessionInfoState;
}

export const SessionActionAvailability = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    capability: CapabilityKeySchema,
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    capability: CapabilityKeySchema,
    reason: z.string().min(1),
  }),
]);
export type SessionActionAvailability = z.infer<typeof SessionActionAvailability>;

/** A typed result used by D5's session and project command adapters. */
export const SessionCommandResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), value: z.unknown() }),
  z.strictObject({ status: z.literal("cancelled") }),
  z.strictObject({ status: z.literal("unavailable"), error: AppErrorSchema }),
  z.strictObject({ status: z.literal("error"), error: AppErrorSchema }),
]);
export type SessionCommandResult = z.infer<typeof SessionCommandResult>;

export type SessionCommandOutcome<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable" | "error"; readonly error: z.infer<typeof AppErrorSchema> };

/** Directly typed result returned by the handoff seam; no command-output text crosses the browser. */
export const HandoffRequest = z.strictObject({
  customInstructions: z.string().optional(),
});
export type HandoffRequest = z.infer<typeof HandoffRequest>;

export const HandoffResult = z.strictObject({
  savedPath: SessionFilePathSchema.nullable(),
  summaryEntryId: EntryId.nullable(),
  sessionSettled: z.boolean(),
});
export type HandoffResult = z.infer<typeof HandoffResult>;

/** A1-backed workspace roots, kept distinct from the selected session id. */
export const WorkspaceDirectorySnapshot = z.strictObject({
  cwd: FolderPath,
  additionalDirectories: z.array(FolderPath),
  revision: Revision,
});
export type WorkspaceDirectorySnapshot = z.infer<typeof WorkspaceDirectorySnapshot>;

export const WorkspaceDirectoryRequest = z.strictObject({ path: FolderPath });
export type WorkspaceDirectoryRequest = z.infer<typeof WorkspaceDirectoryRequest>;

/** SSH metadata deliberately contains a key label only; private-key bytes never enter the browser. */
export const SshScope = z.enum(["global", "project"]);
export type SshScope = z.infer<typeof SshScope>;

export const SshHost = z.strictObject({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  user: z.string().trim().min(1).optional(),
  port: z.int().min(1).max(65535).optional(),
  scope: SshScope,
  keyLabel: z.string().trim().min(1).optional(),
});
export type SshHost = z.infer<typeof SshHost>;

export const SshListResult = z.strictObject({
  hosts: z.array(SshHost),
});
export type SshListResult = z.infer<typeof SshListResult>;

export const SshHelpResult = z.strictObject({
  text: z.string(),
});
export type SshHelpResult = z.infer<typeof SshHelpResult>;

/** Capabilities D5.1 consumes for session info and R1.7-backed session actions. */
export const D5_COMMAND_CAPABILITIES = Object.freeze({
  info: "omp.cmd.get_state" as CapabilityKey,
  rename: "omp.cmd.set_session_name" as CapabilityKey,
  pin: "host.session-pins" as CapabilityKey,
  delete: "host.command-gateway" as CapabilityKey,
} as const satisfies Readonly<Record<SessionActionCommand, CapabilityKey>>);
