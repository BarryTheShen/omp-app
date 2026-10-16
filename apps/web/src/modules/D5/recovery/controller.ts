import {
  AppFailure,
  type CapabilityKey,
  type CommandRunResult,
  type OmpCommandGateway,
  type PortClient,
  type ThreadId,
  UiRequestId as UiRequestIdSchema,
} from "@omp-app/contracts";
import type { ProcessState } from "../../R0/store";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type {
  HandoffPort,
  HandoffRequest,
  HandoffResult,
  SessionActionAvailability,
  SessionCapabilitiesSource,
  SessionCommandOutcome,
} from "../contract";

export type RecoveryCommand = "handoff" | "retry";

/** The capability each recovery command needs; `/retry` runs through the command gateway like `/fresh`. */
export const RECOVERY_CAPABILITIES = Object.freeze({
  handoff: "omp.cmd.handoff",
  retry: "host.command-gateway",
} as const satisfies Readonly<Record<RecoveryCommand, CapabilityKey>>);

/** The open session's thread id; the session info snapshot provides it. */
export interface OpenSessionSource {
  readonly getSnapshot: () => { readonly id: ThreadId };
}

/** R0's process state for the open session: omp must be up before either command can run. */
export interface ProcessSource {
  readonly getSnapshot: () => ProcessState;
}

/** R0's prompt lifecycle: while a reply streams, omp refuses both commands, so the app refuses them first. */
export interface PromptSource {
  readonly getSnapshot: () => { readonly streaming: boolean };
}

export type RecoveryPhase =
  | { readonly status: "idle" }
  | { readonly status: "confirming" }
  | { readonly status: "running" }
  | {
      readonly status: "done";
      readonly outcome: "completed" | "cancelled" | "unavailable" | "error";
      readonly message?: string;
    };

export interface RecoveryState {
  readonly handoff: RecoveryPhase;
  readonly retry: RecoveryPhase;
}

export interface RecoveryOptions {
  readonly signal?: AbortSignal;
}

export interface HandoffOptions extends RecoveryOptions {
  /**
   * Puts the text the person sent (`/handoff ...`) back into the composer when no handoff happens,
   * so nothing they typed is lost. The composition passes the composer's `setEditorText`.
   */
  readonly restoreDraft?: () => void;
}

export interface RecoveryControllerOptions {
  readonly session: OpenSessionSource;
  readonly handoff: Pick<HandoffPort, "createHandoff">;
  readonly gateway: Pick<PortClient<typeof OmpCommandGateway>, "run">;
  readonly dialogs: Pick<DialogHost, "confirm">;
  readonly capabilities: SessionCapabilitiesSource;
  readonly process: ProcessSource;
  readonly prompt: PromptSource;
  /**
   * Brings the open transcript up to date after a completed handoff. A handoff starts no turn, so
   * no `session_settled` reloads it. The composition passes the history store's `refreshAfterCommand`.
   */
  readonly afterHandoff: () => Promise<void>;
}

const IDLE: RecoveryPhase = { status: "idle" };

const BUSY_HANDOFF = "Wait for the current reply to finish, then hand off the conversation.";
const BUSY_RETRY = "Wait for the current reply to finish, then try again.";
const ALREADY_RUNNING = "Wait for the current action to finish.";
const NOTHING_TO_RETRY = "There is no failed reply to retry.";
const HANDOFF_FALLBACK = "The handoff did not finish.";
const RETRY_FALLBACK = "Retrying the failed reply did not finish.";

/**
 * `/handoff` and `/retry` for the open session. Each action checks its capability, omp's process
 * state and whether a reply is streaming, confirms a handoff before it starts, and returns a typed
 * outcome; the browser never reads omp's text (a reply that starts no turn is read from
 * `agentInvoked`). Only one of the two runs at a time. Phases are published so a view can show
 * pending, done, cancelled and failed states without holding its own copy of the outcome.
 */
export class RecoveryController {
  private readonly options: RecoveryControllerOptions;
  private state: RecoveryState = { handoff: IDLE, retry: IDLE };
  private readonly listeners = new Set<() => void>();
  /** The command in flight, if any: handoff and retry never run at once. */
  private running: RecoveryCommand | null = null;

  public constructor(options: RecoveryControllerOptions) {
    this.options = options;
  }

  /** The same object until a phase changes, so `useSyncExternalStore` does not re-render on every read. */
  public getState(): RecoveryState {
    return this.state;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getAvailability(command: RecoveryCommand): SessionActionAvailability {
    const capability = RECOVERY_CAPABILITIES[command];
    const status = this.options.capabilities.getSnapshot()[capability];
    if (status?.state !== "available" && status?.state !== "fallback") {
      return {
        state: "unavailable",
        capability,
        reason:
          status?.detail?.trim() ||
          (command === "handoff"
            ? "Handing off this conversation is unavailable for this connection."
            : "Retrying the failed reply is unavailable for this connection."),
      };
    }
    const processReason = processBlockReason(this.options.process.getSnapshot());
    if (processReason !== undefined) {
      return { state: "unavailable", capability, reason: processReason };
    }
    return { state: "available", capability };
  }

  public async handoff(
    request: HandoffRequest = {},
    options: HandoffOptions = {},
  ): Promise<SessionCommandOutcome<HandoffResult>> {
    const outcome = await this.exclusive("handoff", () => this.runHandoff(request, options.signal));
    if (outcome.status !== "completed") options.restoreDraft?.();
    try {
      if (outcome.status === "completed") await this.options.afterHandoff();
    } finally {
      this.settle("handoff", outcome);
    }
    return outcome;
  }

  public async retry(
    options: RecoveryOptions = {},
  ): Promise<SessionCommandOutcome<CommandRunResult>> {
    const outcome = await this.exclusive("retry", () => this.runRetry(options.signal));
    this.settle("retry", outcome);
    return outcome;
  }

  /** Runs one command at a time; a second one is refused at once, and it never reaches omp. */
  private async exclusive<Value>(
    command: RecoveryCommand,
    run: () => Promise<SessionCommandOutcome<Value>>,
  ): Promise<SessionCommandOutcome<Value>> {
    if (this.running !== null) return busyOutcome<Value>(ALREADY_RUNNING);
    this.running = command;
    try {
      return await run();
    } finally {
      this.running = null;
    }
  }

  private async runHandoff(
    request: HandoffRequest,
    signal?: AbortSignal,
  ): Promise<SessionCommandOutcome<HandoffResult>> {
    try {
      const blocked = this.refusal<HandoffResult>("handoff", BUSY_HANDOFF);
      if (blocked) return blocked;

      const threadId = this.options.session.getSnapshot().id;
      this.update("handoff", { status: "confirming" });
      const confirmed = await this.options.dialogs.confirm(
        {
          kind: "confirm",
          id: UiRequestIdSchema.parse(`app-d5-handoff-${crypto.randomUUID()}`),
          title: "Hand off this conversation?",
          message: "omp summarizes the conversation so far and continues from that summary.",
        },
        signal === undefined ? { threadId, origin: "app" } : { threadId, signal, origin: "app" },
      );
      if (!confirmed) return { status: "cancelled" };
      if (this.options.session.getSnapshot().id !== threadId) {
        return {
          status: "error",
          error: {
            code: "conflict",
            message: "You switched sessions before the handoff could start.",
            retryable: true,
          },
        };
      }

      const latest = this.refusal<HandoffResult>("handoff", BUSY_HANDOFF);
      if (latest) return latest;
      this.update("handoff", { status: "running" });
      const value = await this.options.handoff.createHandoff(request);
      return { status: "completed", value };
    } catch (error) {
      return failureOutcome(error, HANDOFF_FALLBACK);
    }
  }

  private async runRetry(signal?: AbortSignal): Promise<SessionCommandOutcome<CommandRunResult>> {
    try {
      const blocked = this.refusal<CommandRunResult>("retry", BUSY_RETRY);
      if (blocked) return blocked;

      const threadId = this.options.session.getSnapshot().id;
      this.update("retry", { status: "running" });
      const run = await this.options.gateway.run(
        { threadId, command: "/retry" },
        signal === undefined ? undefined : { signal },
      );
      if (run.agentInvoked) return { status: "completed", value: run };
      // omp consumed `/retry` and started no turn: there was no failed reply to retry, or a reply
      // began while the command was on its way.
      return this.options.prompt.getSnapshot().streaming
        ? busyOutcome<CommandRunResult>(BUSY_RETRY)
        : unavailableOutcome<CommandRunResult>(NOTHING_TO_RETRY);
    } catch (error) {
      return failureOutcome(error, RETRY_FALLBACK);
    }
  }

  /** Why a command cannot start now, as an outcome; undefined when it can. */
  private refusal<Value>(
    command: RecoveryCommand,
    busyMessage: string,
  ): SessionCommandOutcome<Value> | undefined {
    const availability = this.getAvailability(command);
    if (availability.state === "unavailable") {
      return unavailableOutcome<Value>(availability.reason);
    }
    return this.options.prompt.getSnapshot().streaming
      ? busyOutcome<Value>(busyMessage)
      : undefined;
  }

  private settle<Value>(command: RecoveryCommand, outcome: SessionCommandOutcome<Value>): void {
    if (outcome.status === "completed") {
      this.update(command, { status: "done", outcome: "completed" });
    } else if (outcome.status === "cancelled") {
      this.update(command, { status: "done", outcome: "cancelled" });
    } else {
      this.update(command, {
        status: "done",
        outcome: outcome.status,
        message: outcome.error.message,
      });
    }
  }

  private update(command: RecoveryCommand, phase: RecoveryPhase): void {
    this.state = { ...this.state, [command]: phase };
    for (const listener of [...this.listeners]) listener();
  }
}

/** Why omp's process cannot take a recovery command now; undefined when it can. */
export function processBlockReason(process: ProcessState): string | undefined {
  switch (process.status) {
    case "ready":
    case "running":
      return undefined;
    case "starting":
      return "omp is still starting. Try again in a moment.";
    case "stopped":
      return "omp is not running. Start it again to continue.";
    case "exited":
      return "omp stopped. Start it again to continue.";
    case "error":
      return process.error?.message ?? "omp hit an error. Start it again to continue.";
  }
}

function unavailableOutcome<Value>(message: string): SessionCommandOutcome<Value> {
  return { status: "unavailable", error: { code: "unavailable", message, retryable: false } };
}

/** A refusal that a moment later would succeed: the reply in flight or the other command must finish first. */
function busyOutcome<Value>(message: string): SessionCommandOutcome<Value> {
  return { status: "unavailable", error: { code: "conflict", message, retryable: true } };
}

/** Maps a failure to a typed outcome; AppFailure keeps its own code and message, anything else gets a plain sentence. */
function failureOutcome<Value>(error: unknown, fallback: string): SessionCommandOutcome<Value> {
  if (error instanceof AppFailure) {
    if (error.appError.code === "cancelled") return { status: "cancelled" };
    return { status: "error", error: error.appError };
  }
  // Anything else is a bug or a lost connection: the person sees the plain sentence, not the raw message.
  return { status: "error", error: { code: "internal", message: fallback, retryable: false } };
}
