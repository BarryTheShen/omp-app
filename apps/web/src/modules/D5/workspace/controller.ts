import type { AppClient } from "@omp-app/client";
import {
  type AppError,
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  type CommandRunResult,
  FolderPath,
  HostMetadataPort,
  OmpCommandGateway,
  type PortCallOptions,
  type PortClient,
  SlashCommand,
  type ThreadId,
  type WorkspaceState,
  WorkspaceStatePort,
} from "@omp-app/contracts";
import type {
  SessionActionAvailability,
  SessionCapabilitiesSource,
  SessionCommandOutcome,
  SessionInfoSource,
} from "../contract";
import {
  confirmWorkspaceAction,
  promptWorkspaceChoice,
  promptWorkspaceText,
  type WorkspaceDialogs,
} from "./dialogs";
import {
  WORKSPACE_CAPABILITIES,
  WORKTREE_UNAVAILABLE_REASON,
  type WorkspaceActionName,
  type WorkspaceViewModel,
} from "./models";
import { requestSshCommand } from "./ssh";

type WorkspaceStateClient = Pick<PortClient<typeof WorkspaceStatePort>, "read">;
type HostMetadataClient = Pick<PortClient<typeof HostMetadataPort>, "read">;
type CommandGatewayClient = Pick<PortClient<typeof OmpCommandGateway>, "run">;

export interface WorkspaceControllerOptions {
  readonly client: AppClient;
  readonly session: SessionInfoSource;
  readonly capabilities: SessionCapabilitiesSource;
  readonly dialogs: WorkspaceDialogs;
}

interface ActiveSessionFolder {
  readonly threadId: ThreadId;
  readonly folder: FolderPath;
}

interface PostCommandRefresh {
  readonly directoryList?: boolean;
  readonly folder?: FolderPath;
}

const OTHER_FOLDER_OPTION = "Choose another existing folder…";
const ACTION_LABELS: Record<WorkspaceActionName, string> = {
  refresh: "Refresh workspace",
  "add-directory": "Add directory",
  "remove-directory": "Remove directory",
  "move-session": "Move session",
  "manage-ssh": "Manage SSH hosts",
  worktree: "Worktree",
};

function callOptions(signal?: AbortSignal): PortCallOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

function capabilityAvailability(
  capabilities: CapabilityMap,
  capability: CapabilityKey,
  fallback: string,
): SessionActionAvailability {
  const status = capabilities[capability];
  if (status?.state === "available" || status?.state === "fallback") {
    return { state: "available", capability };
  }
  return {
    state: "unavailable",
    capability,
    reason: status?.detail?.trim() || fallback,
  };
}

type WorkspaceErrorOutcome = {
  readonly status: "error" | "unavailable";
  readonly error: AppError;
};

type WorkspaceFailureOutcome = WorkspaceErrorOutcome | { readonly status: "cancelled" };

function failure(cause: unknown, fallback: string): WorkspaceFailureOutcome {
  if (cause instanceof AppFailure) {
    if (cause.appError.code === "cancelled") return { status: "cancelled" };
    return {
      status: cause.appError.code === "unavailable" ? "unavailable" : "error",
      error: cause.appError,
    };
  }
  return { status: "error", error: { code: "internal", message: fallback, retryable: true } };
}

function invalid(
  message: string,
  code: "invalid_args" | "conflict" = "invalid_args",
  retryable = false,
): WorkspaceErrorOutcome {
  return { status: "error", error: { code, message, retryable } };
}

function unavailable(availability: SessionActionAvailability): WorkspaceErrorOutcome {
  if (availability.state === "available") {
    return {
      status: "error",
      error: { code: "internal", message: "Expected an unavailable capability.", retryable: false },
    };
  }
  return {
    status: "unavailable",
    error: new AppFailure({
      code: "unavailable",
      message: availability.reason,
      retryable: false,
      capability: availability.capability,
    }).appError,
  };
}

function actionPresentation(
  availability: SessionActionAvailability,
  busyAction: WorkspaceActionName | null,
): WorkspaceViewModel["actions"][WorkspaceActionName] {
  if (availability.state === "unavailable") return { disabled: true, reason: availability.reason };
  if (busyAction !== null)
    return { disabled: true, reason: "Another workspace action is running." };
  return { disabled: false, reason: null };
}

/** A1 owns filesystem and OMP effects; this controller only invokes its typed ports. */
export class WorkspaceController {
  private readonly workspaceState: WorkspaceStateClient;
  private readonly hostMetadata: HostMetadataClient;
  private readonly gateway: CommandGatewayClient;
  private readonly session: SessionInfoSource;
  private readonly capabilities: SessionCapabilitiesSource;
  private readonly dialogs: WorkspaceDialogs;
  private readonly listeners = new Set<(model: WorkspaceViewModel) => void>();
  private model: WorkspaceViewModel;
  private disposed = false;
  private stopSession: () => void;
  private lastSessionId: ThreadId;
  private lastFolder: FolderPath | null;

  public constructor(options: WorkspaceControllerOptions) {
    this.workspaceState = options.client.port(WorkspaceStatePort);
    this.hostMetadata = options.client.port(HostMetadataPort);
    this.gateway = options.client.port(OmpCommandGateway);
    this.session = options.session;
    this.capabilities = options.capabilities;
    this.dialogs = options.dialogs;
    this.model = {
      status: "idle",
      workspace: null,
      directoryList: null,
      lastCommand: null,
      lastCommandLabel: null,
      busyAction: null,
      error: null,
      actions: this.actionPresentations(null),
    };
    const session = this.session.getSnapshot();
    this.lastSessionId = session.id;
    this.lastFolder = session.cwd;
    this.stopSession = this.session.subscribe(() => this.resetForSessionChange());
  }

  public getSnapshot(): WorkspaceViewModel {
    return this.model;
  }

  public subscribe(listener: (model: WorkspaceViewModel) => void): () => void {
    if (this.disposed) throw new Error("WorkspaceController has been disposed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSession();
    this.listeners.clear();
  }

  public getAvailability(action: WorkspaceActionName): SessionActionAvailability {
    const capabilities = this.capabilities.getSnapshot();
    if (action === "worktree") {
      return {
        state: "unavailable",
        capability: WORKSPACE_CAPABILITIES.worktree,
        reason: WORKTREE_UNAVAILABLE_REASON,
      };
    }
    if (action === "refresh" || action === "move-session") {
      const state = capabilityAvailability(
        capabilities,
        WORKSPACE_CAPABILITIES.state,
        "Workspace state is unavailable for this connection.",
      );
      if (state.state === "unavailable") return state;
      if (action === "refresh") return state;
    }
    const gateway = capabilityAvailability(
      capabilities,
      WORKSPACE_CAPABILITIES.commands,
      "omp commands are unavailable for this connection.",
    );
    if (gateway.state === "unavailable") return gateway;
    if (action === "manage-ssh") return gateway;
    return capabilityAvailability(
      capabilities,
      WORKSPACE_CAPABILITIES.metadata,
      "Folder validation is unavailable for this connection.",
    );
  }

  public async refresh(signal?: AbortSignal): Promise<void> {
    if (this.disposed || this.model.busyAction !== null) return;
    const availability = this.getAvailability("refresh");
    if (availability.state === "unavailable") {
      this.update({ status: "error", error: unavailable(availability).error });
      return;
    }
    const session = this.activeSessionFolder();
    if (session instanceof AppFailure) {
      this.update({ status: "error", error: session.appError });
      return;
    }

    this.update({ status: "loading", busyAction: "refresh", error: null });
    try {
      const workspace = await this.workspaceState.read(
        { folder: session.folder },
        callOptions(signal),
      );
      if (!this.isCurrentSession(session)) {
        this.update({
          status: "error",
          workspace: null,
          directoryList: null,
          lastCommand: null,
          lastCommandLabel: null,
          busyAction: null,
          error: new AppFailure({
            code: "conflict",
            message: "The active session changed while workspace state was loading.",
            retryable: true,
          }).appError,
        });
        return;
      }

      const commandAvailability = this.getAvailability("manage-ssh");
      let directoryList: CommandRunResult | null = null;
      let error: AppError | null = null;
      if (commandAvailability.state === "available") {
        try {
          directoryList = await this.gateway.run(
            { threadId: session.threadId, command: SlashCommand.parse("/dirs") },
            callOptions(signal),
          );
        } catch (cause) {
          const outcome = failure(cause, "Could not list workspace directories.");
          error = outcome.status === "cancelled" ? null : outcome.error;
        }
      } else {
        error = unavailable(commandAvailability).error;
      }
      if (!this.isCurrentSession(session)) {
        this.update({
          status: "error",
          workspace: null,
          directoryList: null,
          lastCommand: null,
          lastCommandLabel: null,
          busyAction: null,
          error: new AppFailure({
            code: "conflict",
            message: "The active session changed while its directory list was loading.",
            retryable: true,
          }).appError,
        });
        return;
      }
      this.update({
        status: error ? "error" : "ready",
        workspace,
        directoryList,
        lastCommand: null,
        lastCommandLabel: null,
        busyAction: null,
        error,
      });
    } catch (cause) {
      const outcome = failure(cause, "Could not load workspace state.");
      this.update({
        status: outcome.status === "cancelled" ? "idle" : "error",
        busyAction: null,
        error: outcome.status === "cancelled" ? null : outcome.error,
      });
    }
  }

  public addDirectory(signal?: AbortSignal): Promise<SessionCommandOutcome<CommandRunResult>> {
    return this.changeDirectory("add-directory", signal);
  }

  public removeDirectory(signal?: AbortSignal): Promise<SessionCommandOutcome<CommandRunResult>> {
    return this.changeDirectory("remove-directory", signal);
  }

  public async moveSession(signal?: AbortSignal): Promise<SessionCommandOutcome<CommandRunResult>> {
    if (this.model.busyAction !== null)
      return invalid("Another workspace action is already running.", "conflict", true);
    if (!this.model.workspace) await this.refresh(signal);
    if (!this.model.workspace) {
      return this.finishFailure(
        new AppFailure({
          code: "unavailable",
          message: "Workspace locations are not available yet. Refresh and try again.",
          retryable: true,
          capability: WORKSPACE_CAPABILITIES.state,
        }),
        "move-session",
      );
    }
    const blocked = this.begin("move-session");
    if (blocked) return blocked;
    const session = this.activeSessionFolder();
    if (session instanceof AppFailure) return this.finishFailure(session, "move-session");

    const workspace = this.model.workspace;
    const folders = [
      ...new Set([
        ...workspace.additionalDirectories,
        ...workspace.git.worktrees.map((worktree) => worktree.path),
      ]),
    ].filter((folder) => folder !== workspace.folder);
    const choice = await promptWorkspaceChoice(
      this.dialogs,
      session.threadId,
      "Choose an existing folder",
      [...folders, OTHER_FOLDER_OPTION],
      "move-select",
      signal,
      [
        ...folders.map(() => ({ description: "Existing workspace folder" })),
        { description: "Enter an existing folder path" },
      ],
    );
    if (choice.status !== "completed") return this.finishDialog("move-session", choice);
    let target = choice.value;
    if (target === OTHER_FOLDER_OPTION) {
      const input = await promptWorkspaceText(
        this.dialogs,
        session.threadId,
        "Move to an existing folder",
        "/path/to/existing/folder",
        "move-folder",
        signal,
      );
      if (input.status !== "completed") return this.finishDialog("move-session", input);
      const folder = await this.validateFolder(input.value, signal);
      if (folder.status !== "completed") return this.finishDialog("move-session", folder);
      target = folder.value;
    } else {
      const folder = await this.validateFolder(target, signal);
      if (folder.status !== "completed") return this.finishDialog("move-session", folder);
      target = folder.value;
    }
    if (target === session.folder) {
      return this.finishFailure(
        new AppFailure({
          code: "invalid_args",
          message: "Choose a different folder to move this session.",
          retryable: false,
        }),
        "move-session",
      );
    }
    if (!this.isCurrentSession(session)) return this.sessionChanged("move-session");
    const confirmed = await confirmWorkspaceAction(
      this.dialogs,
      session.threadId,
      "Move this session?",
      `Move the current session to ${target}? omp will move its native session data.`,
      "move-session-confirm",
      signal,
    );
    if (confirmed.status !== "completed") return this.finishDialog("move-session", confirmed);
    if (!confirmed.value) return this.finishCancelled("move-session");
    if (!this.isCurrentSession(session)) return this.sessionChanged("move-session");
    return this.runCommand(
      "move-session",
      "Move session",
      `/move ${target}`,
      session.threadId,
      signal,
      { folder: target },
    );
  }

  public async manageSsh(signal?: AbortSignal): Promise<SessionCommandOutcome<CommandRunResult>> {
    const blocked = this.begin("manage-ssh");
    if (blocked) return blocked;
    const threadId = this.session.getSnapshot().id;
    const request = await requestSshCommand(this.dialogs, threadId, signal);
    if (request.status !== "completed") return this.finishDialog("manage-ssh", request);
    if (!this.isCurrentThread(threadId)) return this.sessionChanged("manage-ssh");
    return this.runCommand(
      "manage-ssh",
      request.value.label,
      request.value.command,
      threadId,
      signal,
    );
  }

  public worktree(): Promise<SessionCommandOutcome<never>> {
    return Promise.resolve(unavailable(this.getAvailability("worktree")));
  }

  private async changeDirectory(
    action: "add-directory" | "remove-directory",
    signal?: AbortSignal,
  ): Promise<SessionCommandOutcome<CommandRunResult>> {
    const blocked = this.begin(action);
    if (blocked) return blocked;
    const session = this.activeSessionFolder();
    if (session instanceof AppFailure) return this.finishFailure(session, action);
    const isRemoval = action === "remove-directory";
    const input = await promptWorkspaceText(
      this.dialogs,
      session.threadId,
      isRemoval
        ? "Remove an additional workspace directory"
        : "Add an existing workspace directory",
      "/path/to/existing/folder",
      action,
      signal,
    );
    if (input.status !== "completed") return this.finishDialog(action, input);
    const folder = await this.validateFolder(input.value, signal);
    if (folder.status !== "completed") return this.finishDialog(action, folder);
    if (isRemoval && folder.value === session.folder) {
      return this.finishFailure(
        new AppFailure({
          code: "invalid_args",
          message: "The working directory cannot be removed. Move the session first.",
          retryable: false,
        }),
        action,
      );
    }
    if (!this.isCurrentSession(session)) return this.sessionChanged(action);
    if (isRemoval) {
      const confirmed = await confirmWorkspaceAction(
        this.dialogs,
        session.threadId,
        "Remove workspace directory?",
        `Remove ${folder.value} from this session's workspace? The folder and its files will remain unchanged.`,
        "remove-directory-confirm",
        signal,
      );
      if (confirmed.status !== "completed") return this.finishDialog(action, confirmed);
      if (!confirmed.value) return this.finishCancelled(action);
      if (!this.isCurrentSession(session)) return this.sessionChanged(action);
    }
    const command = isRemoval ? `/remove-dir ${folder.value}` : `/add-dir ${folder.value}`;
    return this.runCommand(action, ACTION_LABELS[action], command, session.threadId, signal, {
      directoryList: true,
    });
  }

  private async validateFolder(
    value: string,
    signal?: AbortSignal,
  ): Promise<SessionCommandOutcome<FolderPath>> {
    const folder = FolderPath.safeParse(value);
    if (!folder.success || /[\r\n\0]/.test(value)) {
      return invalid("Enter an absolute folder path without line breaks.");
    }
    const availability = this.getAvailability("add-directory");
    if (availability.state === "unavailable") return unavailable(availability);
    try {
      await this.hostMetadata.read({ folder: folder.data }, callOptions(signal));
      return { status: "completed", value: folder.data };
    } catch (cause) {
      if (cause instanceof AppFailure && cause.appError.code === "not_found") {
        return {
          status: "error",
          error: new AppFailure({
            code: "not_found",
            message: "This folder doesn't exist. Create it first, then pick it.",
            retryable: false,
          }).appError,
        };
      }
      return failure(cause, "The folder could not be validated.");
    }
  }

  private async runCommand(
    action: WorkspaceActionName,
    label: string,
    text: string,
    threadId: ThreadId,
    signal?: AbortSignal,
    refresh?: PostCommandRefresh,
  ): Promise<SessionCommandOutcome<CommandRunResult>> {
    const availability = this.getAvailability(action);
    if (availability.state === "unavailable") {
      const blocked = unavailable(availability);
      this.finishDialog(action, blocked);
      return blocked;
    }
    const command = SlashCommand.safeParse(text);
    if (!command.success) {
      return this.finishFailure(
        new AppFailure({
          code: "invalid_args",
          message: "The workspace command is invalid.",
          retryable: false,
        }),
        action,
      );
    }
    try {
      const result = await this.gateway.run(
        { threadId, command: command.data },
        callOptions(signal),
      );
      if (!this.isCurrentThread(threadId)) {
        const error = new AppFailure({
          code: "conflict",
          message: "The selected session changed while the workspace command was running.",
          retryable: true,
        }).appError;
        this.update({
          status: "error",
          busyAction: null,
          workspace: null,
          directoryList: null,
          lastCommand: null,
          lastCommandLabel: label,
          error,
        });
        return { status: "error", error };
      }
      if (result.status === "aborted") {
        this.update({
          status: "ready",
          busyAction: null,
          lastCommand: result,
          lastCommandLabel: label,
          error: null,
        });
        return { status: "cancelled" };
      }
      let directoryList: CommandRunResult | undefined;
      let workspace: WorkspaceState | undefined;
      let refreshError: AppError | null = null;
      if (refresh?.directoryList) {
        try {
          directoryList = await this.gateway.run(
            { threadId, command: SlashCommand.parse("/dirs") },
            callOptions(signal),
          );
        } catch (cause) {
          const outcome = failure(
            cause,
            "Could not refresh the workspace directory list after the command.",
          );
          refreshError =
            outcome.status === "cancelled"
              ? {
                  code: "cancelled",
                  message: "The command completed, but the directory list refresh was cancelled.",
                  retryable: true,
                }
              : outcome.error;
        }
      }
      if (refresh?.folder) {
        try {
          workspace = await this.workspaceState.read(
            { folder: refresh.folder },
            callOptions(signal),
          );
        } catch (cause) {
          const outcome = failure(
            cause,
            "Could not refresh workspace state after moving the session.",
          );
          refreshError =
            outcome.status === "cancelled"
              ? {
                  code: "cancelled",
                  message: "The session moved, but its workspace refresh was cancelled.",
                  retryable: true,
                }
              : outcome.error;
        }
      }
      if (!this.isCurrentThread(threadId)) {
        const error = new AppFailure({
          code: "conflict",
          message: "The selected session changed while the workspace command was running.",
          retryable: true,
        }).appError;
        this.update({
          status: "error",
          busyAction: null,
          workspace: null,
          directoryList: null,
          lastCommand: null,
          lastCommandLabel: label,
          error,
        });
        return { status: "error", error };
      }
      this.update({
        status: refreshError ? "error" : "ready",
        busyAction: null,
        lastCommand: result,
        lastCommandLabel: label,
        ...(directoryList === undefined ? {} : { directoryList }),
        ...(workspace === undefined ? {} : { workspace }),
        error: refreshError,
      });
      return { status: "completed", value: result };
    } catch (cause) {
      return this.finishFailure(cause, action, `${label} failed.`);
    }
  }

  private begin(action: WorkspaceActionName): SessionCommandOutcome<never> | null {
    if (this.disposed) return invalid("The workspace panel is no longer active.");
    if (this.model.busyAction !== null) {
      return invalid("Another workspace action is already running.", "conflict", true);
    }
    const availability = this.getAvailability(action);
    if (availability.state === "unavailable") {
      const outcome = unavailable(availability);
      this.finishDialog(action, outcome);
      return outcome;
    }
    this.update({ status: "ready", busyAction: action, error: null });
    return null;
  }

  private finishDialog<Value>(
    action: WorkspaceActionName,
    outcome: SessionCommandOutcome<Value>,
  ): SessionCommandOutcome<Value> {
    if (outcome.status === "error" || outcome.status === "unavailable") {
      this.update({
        status: "error",
        busyAction: null,
        error: outcome.error,
        lastCommandLabel: ACTION_LABELS[action],
      });
    } else {
      this.update({ status: "ready", busyAction: null, error: null });
    }
    return outcome;
  }

  private finishCancelled(action: WorkspaceActionName): SessionCommandOutcome<never> {
    this.update({
      status: "ready",
      busyAction: null,
      error: null,
      lastCommandLabel: ACTION_LABELS[action],
    });
    return { status: "cancelled" };
  }

  private finishFailure<Value>(
    cause: unknown,
    action: WorkspaceActionName,
    fallback = "The workspace action failed.",
  ): SessionCommandOutcome<Value> {
    const outcome = failure(cause, fallback);
    if (outcome.status === "cancelled") return this.finishCancelled(action);
    this.update({
      status: "error",
      busyAction: null,
      error: outcome.error,
      lastCommandLabel: ACTION_LABELS[action],
    });
    return outcome;
  }

  private sessionChanged(action: WorkspaceActionName): SessionCommandOutcome<never> {
    return this.finishFailure(
      new AppFailure({
        code: "conflict",
        message: "The selected session changed before the workspace action completed.",
        retryable: true,
      }),
      action,
    );
  }

  private activeSessionFolder(): ActiveSessionFolder | AppFailure {
    const session = this.session.getSnapshot();
    if (session.cwd === null) {
      return new AppFailure({
        code: "not_found",
        message: "No active workspace folder is available for this session.",
        retryable: false,
      });
    }
    return { threadId: session.id, folder: session.cwd };
  }

  private isCurrentSession(session: ActiveSessionFolder): boolean {
    const current = this.session.getSnapshot();
    return current.id === session.threadId && current.cwd === session.folder;
  }

  private isCurrentThread(threadId: ThreadId): boolean {
    return this.session.getSnapshot().id === threadId;
  }
  private resetForSessionChange(): void {
    if (this.disposed) return;
    const current = this.session.getSnapshot();
    if (current.id === this.lastSessionId && current.cwd === this.lastFolder) return;
    this.lastSessionId = current.id;
    this.lastFolder = current.cwd;
    this.update({
      status: this.model.busyAction === null ? "idle" : "loading",
      workspace: null,
      directoryList: null,
      lastCommand: null,
      lastCommandLabel: null,
      error: null,
    });
  }

  private actionPresentations(
    busyAction: WorkspaceActionName | null,
  ): WorkspaceViewModel["actions"] {
    return {
      refresh: actionPresentation(this.getAvailability("refresh"), busyAction),
      "add-directory": actionPresentation(this.getAvailability("add-directory"), busyAction),
      "remove-directory": actionPresentation(this.getAvailability("remove-directory"), busyAction),
      "move-session": actionPresentation(this.getAvailability("move-session"), busyAction),
      "manage-ssh": actionPresentation(this.getAvailability("manage-ssh"), busyAction),
      worktree: actionPresentation(this.getAvailability("worktree"), busyAction),
    };
  }

  private update(patch: Partial<WorkspaceViewModel>): void {
    if (this.disposed) return;
    const busyAction = patch.busyAction === undefined ? this.model.busyAction : patch.busyAction;
    this.model = { ...this.model, ...patch, actions: this.actionPresentations(busyAction) };
    for (const listener of this.listeners) listener(this.model);
  }
}
