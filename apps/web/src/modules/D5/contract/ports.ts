import type { CapabilityMap, SessionPinSetResult, ThreadId } from "@omp-app/contracts";
import type { SessionInfoState } from "../../R0/store";
import type { SessionActionsController } from "../../R1/actions";
import type {
  HandoffRequest,
  HandoffResult,
  SessionActionAvailability,
  SessionActionCommand,
  SessionCommandOutcome,
  SessionDeleteRequest,
  SessionInfoMetadata,
  SessionInfoSnapshot,
  SessionPinRequest,
  SessionRenameRequest,
  SshHelpResult,
  SshHost,
  SshListResult,
  WorkspaceDirectoryRequest,
  WorkspaceDirectorySnapshot,
} from "./models";

export interface SessionInfoSource {
  readonly getSnapshot: () => SessionInfoSnapshot;
  readonly subscribe: (listener: (snapshot: SessionInfoSnapshot) => void) => () => void;
}

/** R1 metadata is read-only here; mutation remains inside R1.7's action controller. */
export interface SelectedSessionSource {
  readonly getSnapshot: () => SessionInfoMetadata | null;
}

export interface SessionCommandPort extends SessionInfoSource {
  readonly getAvailability: (command: SessionActionCommand) => SessionActionAvailability;
  readonly rename: (request: SessionRenameRequest) => Promise<SessionCommandOutcome<void>>;
  readonly pin: (request: SessionPinRequest) => Promise<SessionCommandOutcome<SessionPinSetResult>>;
  readonly delete: (request?: SessionDeleteRequest) => Promise<SessionCommandOutcome<void>>;
}

export interface SessionCapabilitiesSource {
  /** Read the live capability map so command execution cannot rely on stale UI gating. */
  readonly getSnapshot: () => CapabilityMap;
}

/** R1.7's seam consumed by D5; D5 never calls omp or edits a session file for these actions. */
export type SessionActionSeam = Pick<
  SessionActionsController,
  "rename" | "delete" | "setPinned" | "getPinAvailability"
>;

export interface SessionCommandPortOptions {
  readonly actions: SessionActionSeam;
  readonly selectedSession: SelectedSessionSource;
  readonly info: SessionInfoSource;
  readonly capabilities: SessionCapabilitiesSource;
}

export interface WorkspaceDirectoryPort {
  readonly listDirectories: () => Promise<WorkspaceDirectorySnapshot>;
  readonly addDirectory: (
    request: WorkspaceDirectoryRequest,
  ) => Promise<WorkspaceDirectorySnapshot>;
  readonly removeDirectory: (
    request: WorkspaceDirectoryRequest,
  ) => Promise<WorkspaceDirectorySnapshot>;
  readonly moveSession: (request: WorkspaceDirectoryRequest) => Promise<WorkspaceDirectorySnapshot>;
}

export interface HandoffPort {
  readonly createHandoff: (request?: HandoffRequest) => Promise<HandoffResult>;
}

export interface SshPort {
  readonly list: () => Promise<SshListResult>;
  readonly add: (host: SshHost) => Promise<SshListResult>;
  readonly remove: (name: string, scope: SshHost["scope"]) => Promise<SshListResult>;
  readonly help: () => Promise<SshHelpResult>;
}

export interface SessionInfoRuntimeSnapshot {
  readonly threadId: ThreadId;
  readonly session: SessionInfoState;
}

export interface SessionInfoRuntimeSource {
  readonly getSnapshot: () => SessionInfoRuntimeSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface SessionInfoMetadataSource {
  readonly getSnapshot: () => SessionInfoMetadata | null;
  readonly subscribe: (listener: () => void) => () => void;
}
