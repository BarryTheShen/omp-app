import type { AppError, CapabilityKey, CommandRunResult, WorkspaceState } from "@omp-app/contracts";

export const WORKSPACE_CAPABILITIES = Object.freeze({
  state: "host.workspace-state",
  metadata: "host.metadata",
  commands: "host.command-gateway",
  worktree: "upstream.worktree",
} as const satisfies Readonly<Record<string, CapabilityKey>>);

export const WORKTREE_UNAVAILABLE_REASON =
  "Worktree relocation isn't available in the app yet. Use omp's terminal for now.";

export type WorkspaceActionName =
  | "refresh"
  | "add-directory"
  | "remove-directory"
  | "move-session"
  | "manage-ssh"
  | "worktree";

export interface WorkspaceActionPresentation {
  readonly disabled: boolean;
  readonly reason: string | null;
}

export interface WorkspaceViewModel {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly workspace: WorkspaceState | null;
  /** The typed `/dirs` result; its output stays opaque and is never parsed by D5. */
  readonly directoryList: CommandRunResult | null;
  readonly lastCommand: CommandRunResult | null;
  readonly lastCommandLabel: string | null;
  readonly busyAction: WorkspaceActionName | null;
  readonly error: AppError | null;
  readonly actions: Readonly<Record<WorkspaceActionName, WorkspaceActionPresentation>>;
}

/** The workspace view renders data only; its parent owns placement and supplies action callbacks. */
export interface WorkspacePanelActions {
  readonly onRefresh: () => void;
  readonly onAddDirectory: () => void;
  readonly onRemoveDirectory: () => void;
  readonly onMoveSession: () => void;
  readonly onManageSsh: () => void;
  readonly onWorktree: () => void;
}
