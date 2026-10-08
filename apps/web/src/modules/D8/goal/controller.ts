import type {
  AppError,
  CapabilityKey,
  CapabilityMap,
  ThreadId,
  UiRequestId,
} from "@omp-app/contracts";
import { AppFailure, UiRequestId as UiRequestIdSchema } from "@omp-app/contracts";
import type { RuntimeSnapshot } from "../../R0/store";
import type {
  ConfirmDialogRequest,
  EditorDialogRequest,
  InputDialogRequest,
} from "../../U4/contract/dialog";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type { PanelActionAvailability, PanelLifecycle } from "../../U5/panel/contract";
import type {
  AutonomyPort,
  ContinuationStatus,
  Goal,
  GoalCreateRequest,
  GoalRpcArgs,
  GoalState,
} from "../contract";
import {
  continuationStatus,
  D8_AP6_CAPABILITIES,
  GoalCreateRequestSchema,
  GoalModeStateSchema,
  goalStateFromEvent,
  goalStateFromResult,
} from "../contract";
import type { GoalRuntimeStore } from "./runtime";

export type GoalPendingAction = "load" | "create" | "pause" | "resume" | "drop";
export type GoalDialogs = Pick<DialogHost, "open" | "confirm">;

export interface GoalPanelSnapshot {
  readonly lifecycle: PanelLifecycle;
  readonly goalState: GoalState | null;
  readonly goal: Goal | null;
  readonly continuation: ContinuationStatus | null;
  readonly pending: GoalPendingAction | null;
  readonly error: AppError | null;
  readonly notice: string | null;
  readonly capabilityMessage: string | null;
  readonly showCreate: boolean;
  readonly showPause: boolean;
  readonly showResume: boolean;
  readonly showDrop: boolean;
  readonly createAvailability: PanelActionAvailability;
  readonly pauseAvailability: PanelActionAvailability;
  readonly resumeAvailability: PanelActionAvailability;
  readonly dropAvailability: PanelActionAvailability;
  readonly editAvailability: PanelActionAvailability;
  readonly budgetAvailability: PanelActionAvailability;
}

/** omp's `goal.continuationModes` setting: its current value, or `null` while the app cannot read it. */
export interface ContinuationModesSource {
  readonly getSnapshot: () => readonly string[] | null;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface GoalControllerOptions {
  readonly threadId: ThreadId;
  readonly autonomy: AutonomyPort;
  readonly runtime: GoalRuntimeStore;
  readonly dialogs: GoalDialogs;
  readonly capabilities: () => CapabilityMap | undefined;
  readonly continuationModes: ContinuationModesSource;
}

const GOAL_CAPABILITY: CapabilityKey = "omp.cmd.goal";
const GOAL_UPDATE_CAPABILITY = D8_AP6_CAPABILITIES.goalUpdate;
const AVAILABLE_ACTION: PanelActionAvailability = { state: "available" };

function unavailable(capability: CapabilityKey, reason: string): PanelActionAvailability {
  return { state: "unavailable", capability, reason };
}

function appError(cause: unknown, message: string): AppError {
  if (cause instanceof AppFailure) {
    // omp's own reason (for example "Goal mode is disabled (goal.enabled).") is shown as it is.
    const shown = cause.appError.code === "omp_error" ? cause.appError.message : message;
    return new AppFailure({
      code: cause.appError.code,
      message: shown,
      retryable: cause.appError.retryable,
      ...(cause.appError.capability === undefined ? {} : { capability: cause.appError.capability }),
    }).appError;
  }
  return new AppFailure({ code: "internal", message, retryable: true }).appError;
}

function requestId(name: string): UiRequestId {
  return UiRequestIdSchema.parse(`app-d8-goal-${name}-${crypto.randomUUID()}`);
}

function goalFromRuntime(snapshot: RuntimeSnapshot): GoalState | null {
  if (snapshot.session.revision === 0) return null;
  if (snapshot.session.goal === null) {
    return goalStateFromResult(
      { goal: null, state: null },
      "reconciled",
      snapshot.prompt.sessionSettled,
    );
  }
  const modeState = GoalModeStateSchema.safeParse(snapshot.session.goal);
  if (!modeState.success) return null;
  return goalStateFromResult(
    { goal: modeState.data.goal, state: modeState.data },
    "reconciled",
    snapshot.prompt.sessionSettled,
  );
}

function statusAllows(
  operation: Exclude<GoalPendingAction, "load" | "create">,
  goal: Goal | null,
): boolean {
  if (!goal) return false;
  switch (operation) {
    case "pause":
      return goal.status === "active" || goal.status === "budget-limited";
    case "resume":
      return goal.status === "paused";
    case "drop":
      return (
        goal.status === "active" || goal.status === "paused" || goal.status === "budget-limited"
      );
  }
}

function parseBudget(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const budget = Number(trimmed);
  return Number.isSafeInteger(budget) && budget > 0 ? budget : null;
}

function numberText(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export class GoalController {
  private readonly options: GoalControllerOptions;
  private readonly abortController = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private goalState: GoalState | null;
  private sessionSettled: boolean;
  private pending: GoalPendingAction | null = null;
  private error: AppError | null = null;
  private notice: string | null = null;
  private goalEventVersion = 0;
  private lastProcessGeneration: number;
  private lastNeedsRefetch: boolean;
  private needsRefresh = false;
  private started = false;
  private disposed = false;
  private snapshot: GoalPanelSnapshot;

  public constructor(options: GoalControllerOptions) {
    this.options = options;
    const runtime = options.runtime.getSnapshot();
    this.sessionSettled = runtime.prompt.sessionSettled;
    this.goalState = goalFromRuntime(runtime);
    this.lastProcessGeneration = runtime.processGeneration;
    this.lastNeedsRefetch = runtime.needsRefetch;
    this.snapshot = this.deriveSnapshot();
  }

  public getSnapshot = (): GoalPanelSnapshot => this.snapshot;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Starts live goal and settlement subscriptions once, then reconciles with the released goal read. */
  public start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      this.unsubscribe.push(
        this.options.runtime.subscribe((snapshot) => this.onRuntimeSnapshot(snapshot)),
      );
      this.unsubscribe.push(this.options.continuationModes.subscribe(() => this.publish()));
      this.unsubscribe.push(
        this.options.autonomy.subscribeGoal(this.options.threadId, (event) => {
          this.goalEventVersion += 1;
          if (event === null) {
            // omp sent an update this app cannot read: say so, and read the goal again.
            this.notice =
              "omp sent a goal update this app could not read. The goal is being reloaded.";
            this.needsRefresh = true;
            this.publish();
            if (this.pending === null) void this.refresh();
            return;
          }
          this.goalState = goalStateFromEvent(event, this.sessionSettled);
          this.error = null;
          this.notice = null;
          this.publish();
        }),
      );
      void this.refresh();
    } catch (cause) {
      for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
      this.error = appError(cause, "The goal could not be connected to this conversation.");
      this.publish();
    }
  }

  public async refresh(): Promise<void> {
    if (!this.begin("load")) return;
    this.needsRefresh = false;
    const eventVersion = this.goalEventVersion;
    try {
      this.requireCurrentThread();
      if (!this.goalCapabilityAvailable()) {
        // omp has not advertised the goal command yet: keep the refresh pending for the next runtime commit.
        this.needsRefresh = true;
        this.error = null;
        return;
      }
      const result = await this.options.autonomy.goal(
        this.options.threadId,
        { op: "get" },
        { signal: this.abortController.signal },
      );
      if (this.disposed) return;
      this.requireCurrentThread();
      if (eventVersion === this.goalEventVersion) {
        this.goalState = goalStateFromResult(result, "rpc", this.sessionSettled);
      }
      this.error = null;
      this.notice = null;
    } catch (cause) {
      if (!this.disposed && !this.isCancelled(cause)) {
        this.error = appError(cause, "The goal could not be loaded. Try again.");
      }
    } finally {
      this.finish();
    }
  }
  public async create(): Promise<void> {
    if (this.snapshot.createAvailability.state !== "available" || !this.begin("create")) return;
    const eventVersion = this.goalEventVersion;
    try {
      const objective = await this.promptObjective();
      if (objective === null || this.disposed) return;
      const budget = await this.promptBudget();
      if (budget.status === "cancelled" || this.disposed) return;
      const request = GoalCreateRequestSchema.parse({
        objective,
        ...(budget.tokenBudget === undefined ? {} : { token_budget: budget.tokenBudget }),
      });
      const confirmed = await this.reviewGoal(request);
      if (!confirmed || this.disposed) return;
      this.requireCurrentThread();
      if (
        this.goalState?.goal &&
        this.goalState.goal.status !== "complete" &&
        this.goalState.goal.status !== "dropped"
      ) {
        throw new AppFailure({
          code: "conflict",
          message: "A goal became active while you were reviewing this one. Refresh and try again.",
          retryable: true,
        });
      }
      if (!this.goalCapabilityAvailable()) {
        throw new AppFailure({
          code: "unavailable",
          message: "Goal actions are unavailable for this connection.",
          retryable: false,
          capability: GOAL_CAPABILITY,
        });
      }
      const args: GoalRpcArgs = {
        op: "create",
        objective: request.objective,
        ...(request.token_budget === undefined ? {} : { token_budget: request.token_budget }),
      };
      const result = await this.options.autonomy.goal(this.options.threadId, args, {
        signal: this.abortController.signal,
      });
      if (this.disposed) return;
      this.requireCurrentThread();
      if (eventVersion === this.goalEventVersion) {
        this.goalState = goalStateFromResult(result, "rpc", this.sessionSettled);
      }
      this.error = null;
      this.notice = null;
    } catch (cause) {
      if (!this.disposed && !this.isCancelled(cause)) {
        this.error = appError(cause, "The goal could not be created. Try again.");
      }
    } finally {
      this.finish();
    }
  }

  public pause(): Promise<void> {
    return this.runGoalOperation("pause", "pause", "The goal could not be paused. Try again.");
  }

  public resume(): Promise<void> {
    return this.runGoalOperation("resume", "resume", "The goal could not be resumed. Try again.");
  }

  public async drop(): Promise<void> {
    if (this.snapshot.dropAvailability.state !== "available" || !this.begin("drop")) return;
    const goal = this.goalState?.goal;
    if (!goal) {
      this.finish();
      return;
    }
    const eventVersion = this.goalEventVersion;
    try {
      const confirmed = await this.options.dialogs.confirm(
        {
          kind: "confirm",
          id: requestId("drop"),
          title: "Drop this goal?",
          message: `This will stop the goal and cannot be undone. Objective: ${goal.objective.replace(/\s+/g, " ")}.`,
        } satisfies ConfirmDialogRequest,
        this.dialogOptions(),
      );
      if (!confirmed || this.disposed) return;
      this.requireCurrentThread();
      if (
        this.goalState?.goal?.id !== goal.id ||
        !statusAllows("drop", this.goalState?.goal ?? null)
      ) {
        throw new AppFailure({
          code: "conflict",
          message: "The goal changed while you were confirming. Refresh and try again.",
          retryable: true,
        });
      }
      if (!this.goalCapabilityAvailable()) {
        throw new AppFailure({
          code: "unavailable",
          message: "Goal actions are unavailable for this connection.",
          retryable: false,
          capability: GOAL_CAPABILITY,
        });
      }
      const result = await this.options.autonomy.goal(
        this.options.threadId,
        { op: "drop" },
        { signal: this.abortController.signal },
      );
      if (this.disposed) return;
      this.requireCurrentThread();
      if (eventVersion === this.goalEventVersion) {
        if (result.goal === null) {
          const droppedGoal: Goal = { ...goal, status: "dropped" };
          this.goalState = goalStateFromResult(
            { goal: droppedGoal, state: null },
            "rpc",
            this.sessionSettled,
          );
        } else {
          this.goalState = goalStateFromResult(result, "rpc", this.sessionSettled);
        }
      }
      this.error = null;
      this.notice = null;
    } catch (cause) {
      if (!this.disposed && !this.isCancelled(cause)) {
        this.error = appError(cause, "The goal could not be dropped. Try again.");
      }
    } finally {
      this.finish();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.listeners.clear();
  }

  private async runGoalOperation(
    operation: "pause" | "resume",
    op: "pause" | "resume",
    failureMessage: string,
  ): Promise<void> {
    const availability =
      operation === "pause" ? this.snapshot.pauseAvailability : this.snapshot.resumeAvailability;
    if (availability.state !== "available" || !this.begin(operation)) return;
    const eventVersion = this.goalEventVersion;
    try {
      this.requireCurrentThread();
      const result = await this.options.autonomy.goal(
        this.options.threadId,
        { op },
        { signal: this.abortController.signal },
      );
      if (this.disposed) return;
      this.requireCurrentThread();
      if (eventVersion === this.goalEventVersion) {
        this.goalState = goalStateFromResult(result, "rpc", this.sessionSettled);
      }
      this.error = null;
      this.notice = null;
    } catch (cause) {
      if (!this.disposed && !this.isCancelled(cause)) this.error = appError(cause, failureMessage);
    } finally {
      this.finish();
    }
  }

  private async promptObjective(): Promise<string | null> {
    let title = "Set your goal";
    while (!this.disposed) {
      const request: EditorDialogRequest = {
        kind: "editor",
        id: requestId("objective"),
        title,
        prefill: "",
      };
      const result = await this.options.dialogs.open(request, this.dialogOptions());
      if (result.outcome === "cancelled") return null;
      if (result.response.kind !== "editor") {
        throw new AppFailure({
          code: "invalid_args",
          message: "The goal objective dialog returned an unexpected answer.",
          retryable: false,
        });
      }
      const objective = result.response.value.trim();
      if (objective.length > 0) return objective;
      title = "Enter an objective for your goal";
    }
    return null;
  }

  private async promptBudget(): Promise<
    | { readonly status: "completed"; readonly tokenBudget?: number }
    | { readonly status: "cancelled" }
  > {
    let title = "Set a token budget (optional)";
    while (!this.disposed) {
      const request: InputDialogRequest = {
        kind: "input",
        id: requestId("budget"),
        title,
        placeholder: "Whole number of tokens",
        optional: true,
      };
      const result = await this.options.dialogs.open(request, this.dialogOptions());
      if (result.outcome === "cancelled") return { status: "cancelled" };
      if (result.response.kind !== "input") {
        throw new AppFailure({
          code: "invalid_args",
          message: "The token budget dialog returned an unexpected answer.",
          retryable: false,
        });
      }
      const tokenBudget = parseBudget(result.response.value);
      if (tokenBudget === undefined) return { status: "completed" };
      if (tokenBudget !== null) return { status: "completed", tokenBudget };
      title = "Enter a positive whole number of tokens";
    }
    return { status: "cancelled" };
  }

  private async reviewGoal(request: GoalCreateRequest): Promise<boolean> {
    const budgetSentence =
      request.token_budget === undefined
        ? "There is no token budget."
        : `Token budget: ${numberText(request.token_budget)} tokens.`;
    return this.options.dialogs.confirm(
      {
        kind: "confirm",
        id: requestId("review"),
        title: "Review your goal",
        message: `Objective: ${request.objective.replace(/\s+/g, " ")}. ${budgetSentence}`,
      } satisfies ConfirmDialogRequest,
      this.dialogOptions(),
    );
  }

  private dialogOptions(): {
    readonly threadId: ThreadId;
    readonly signal: AbortSignal;
    readonly origin: "app";
  } {
    return {
      threadId: this.options.threadId,
      signal: this.abortController.signal,
      origin: "app",
    };
  }

  private onRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
    if (snapshot.threadId !== this.options.threadId) return;
    const previousGoalState = this.goalState;
    const previousSettled = this.sessionSettled;
    this.sessionSettled = snapshot.prompt.sessionSettled;
    if (this.goalState) {
      if (this.goalState.sessionSettled !== this.sessionSettled) {
        this.goalState = { ...this.goalState, sessionSettled: this.sessionSettled };
      }
    } else {
      this.goalState = goalFromRuntime(snapshot);
    }
    if (this.needsRefresh && this.pending === null && this.goalCapabilityAvailable()) {
      void this.refresh();
    }
    const processChanged = snapshot.processGeneration !== this.lastProcessGeneration;
    const refetchRecovered = this.lastNeedsRefetch && !snapshot.needsRefetch;
    this.lastProcessGeneration = snapshot.processGeneration;
    this.lastNeedsRefetch = snapshot.needsRefetch;
    if (processChanged || refetchRecovered) {
      this.needsRefresh = true;
      if (this.pending === null) void this.refresh();
    }
    // Most R0 commits change nothing the panel shows; publishing those would re-render the panel
    // and make the panel's scroll treat each one as new content.
    if (
      this.goalState !== previousGoalState ||
      this.sessionSettled !== previousSettled ||
      processChanged ||
      refetchRecovered
    ) {
      this.publish();
    }
  }

  private requireCurrentThread(): void {
    if (this.options.runtime.getSnapshot().threadId !== this.options.threadId) {
      throw new AppFailure({
        code: "conflict",
        message: "The selected conversation changed before the goal request could finish.",
        retryable: true,
      });
    }
  }

  private goalCapabilityAvailable(): boolean {
    return this.options.capabilities()?.[GOAL_CAPABILITY]?.state === "available";
  }

  private isCancelled(cause: unknown): boolean {
    return cause instanceof AppFailure && cause.appError.code === "cancelled";
  }

  private begin(operation: GoalPendingAction): boolean {
    if (this.disposed || this.pending !== null) return false;
    this.pending = operation;
    this.error = null;
    this.notice = null;
    this.publish();
    return true;
  }

  private finish(): void {
    if (this.disposed) return;
    this.pending = null;
    this.publish();
    if (this.needsRefresh) void this.refresh();
  }

  private publish(): void {
    this.snapshot = this.deriveSnapshot();
    for (const listener of this.listeners) listener();
  }

  private deriveSnapshot(): GoalPanelSnapshot {
    const goal = this.goalState?.goal ?? null;
    const capabilities = this.options.capabilities();
    const goalAvailable = capabilities?.[GOAL_CAPABILITY]?.state === "available";
    const goalUnavailable = unavailable(
      GOAL_CAPABILITY,
      "Goal actions are unavailable for this connection.",
    );
    const createAvailability = !goalAvailable
      ? goalUnavailable
      : this.goalState === null
        ? unavailable(GOAL_CAPABILITY, "Check the current goal before creating one.")
        : goal === null || goal.status === "complete" || goal.status === "dropped"
          ? AVAILABLE_ACTION
          : unavailable(
              GOAL_CAPABILITY,
              "Drop or finish the current goal before creating another.",
            );
    const actionAvailability = (
      operation: "pause" | "resume" | "drop",
    ): PanelActionAvailability => {
      if (!goalAvailable) return goalUnavailable;
      if (!this.goalState || !goal) return unavailable(GOAL_CAPABILITY, "There is no active goal.");
      if (!statusAllows(operation, goal)) {
        return unavailable(
          GOAL_CAPABILITY,
          operation === "pause"
            ? "This goal cannot be paused in its current state."
            : operation === "resume"
              ? "This goal is not paused."
              : "This goal can no longer be dropped.",
        );
      }
      return AVAILABLE_ACTION;
    };
    const continuation = continuationStatus(goal, this.options.continuationModes.getSnapshot());
    const capabilityMessage = goalAvailable
      ? null
      : "Goal actions are unavailable for this connection.";
    const lifecycle: PanelLifecycle =
      this.error && this.goalState === null
        ? "error"
        : this.goalState === null && !goalAvailable
          ? "unavailable"
          : this.goalState === null
            ? this.pending === null || this.pending === "load"
              ? "loading"
              : "updating"
            : this.error
              ? "error"
              : this.pending !== null
                ? "updating"
                : "populated";
    const updateUnavailable = unavailable(
      GOAL_UPDATE_CAPABILITY,
      "Editing the goal and its token budget is not available yet.",
    );
    return Object.freeze({
      lifecycle,
      goalState: this.goalState,
      goal,
      continuation,
      pending: this.pending,
      error: this.error,
      notice: this.notice,
      capabilityMessage,
      showCreate: goal === null || goal.status === "complete" || goal.status === "dropped",
      showPause: goal?.status === "active" || goal?.status === "budget-limited",
      showResume: goal?.status === "paused",
      showDrop:
        goal?.status === "active" || goal?.status === "paused" || goal?.status === "budget-limited",
      createAvailability,
      pauseAvailability: actionAvailability("pause"),
      resumeAvailability: actionAvailability("resume"),
      dropAvailability: actionAvailability("drop"),
      editAvailability: updateUnavailable,
      budgetAvailability: updateUnavailable,
    });
  }
}
