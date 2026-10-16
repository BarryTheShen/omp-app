import type { AppError } from "@omp-app/contracts";
import {
  formatDuration,
  readWorkerMetrics,
  statusPresentation,
  type WorkerTone,
  workerTitle,
} from "@/modules/P1/panels/model";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import type {
  PanelActionAvailability,
  PanelLifecycle,
  PanelState,
} from "@/modules/U5/panel/contract";
import type { CleanseProgress, PauseGateSnapshot } from "../contract";

export type OperationStatus =
  | CleanseProgress["status"]
  | "preview"
  | "saving"
  | "saved"
  | "amended";

export interface BtwTurn {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly status: "running" | "complete" | "cancelled" | "error" | "interrupted";
  readonly startedAt?: number;
  readonly updatedAt?: number;
  readonly error?: string;
}

export const BTW_STATUS_LABEL: Readonly<Record<BtwTurn["status"], string>> = {
  running: "Running",
  complete: "Done",
  cancelled: "Cancelled",
  error: "Failed",
  interrupted: "Interrupted",
};

export interface BtwPanelModel {
  readonly title: string;
  readonly lifecycle: PanelLifecycle;
  readonly description: string;
  readonly error: AppError | null;
  readonly turns: readonly BtwTurn[];
  readonly selectedId: string | null;
  readonly copy: PanelActionAvailability;
  readonly cancel: PanelActionAvailability;
  readonly branch: PanelActionAvailability;
  readonly unavailableReason?: string;
}

export interface CleanseAgentProgress {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly tone: WorkerTone;
  readonly step: string | null;
  readonly duration: string | null;
}

export interface CleansePanelModel {
  readonly title: string;
  readonly lifecycle: PanelLifecycle;
  readonly status: CleanseProgress["status"];
  readonly description: string;
  readonly error: AppError | null;
  readonly wave: number | null;
  readonly totalWaves: number | null;
  readonly checker: string | null;
  readonly request: string | null;
  readonly progress: number | null;
  readonly message: string | null;
  readonly agents: readonly CleanseAgentProgress[];
  readonly check: PanelActionAvailability;
  readonly run: PanelActionAvailability;
  readonly cancel: PanelActionAvailability;
}

export interface OmfgPanelModel {
  readonly title: string;
  readonly lifecycle: PanelLifecycle;
  readonly status: OperationStatus;
  readonly description: string;
  readonly error: AppError | null;
  readonly complaint: string;
  readonly candidate: string;
  readonly validation: readonly string[];
  readonly save: PanelActionAvailability;
  readonly amend: PanelActionAvailability;
  readonly cancel: PanelActionAvailability;
}

export interface PausePanelModel {
  readonly title: string;
  readonly lifecycle: PanelLifecycle;
  readonly description: string;
  readonly error: AppError | null;
  readonly snapshot: PauseGateSnapshot;
  readonly resume: PanelActionAvailability;
}

export type CleanseInput = Omit<CleanseProgress, "agentIds"> & {
  readonly agentIds: readonly string[];
  readonly checker?: string;
  readonly request?: string;
  readonly roster?: AgentRosterStoreSnapshot;
  readonly error?: AppError | null;
  readonly check?: PanelActionAvailability;
  readonly run?: PanelActionAvailability;
  readonly cancel?: PanelActionAvailability;
};

const FALLBACK_PANEL_UNAVAILABLE = "This panel is not available in this omp session.";
const FALLBACK_ACTION_UNAVAILABLE = "This action is not available in this omp session.";

function panelLifecycle(status: OperationStatus, hasContent: boolean): PanelLifecycle {
  if (status === "unknown") return "unavailable";
  if (status === "failed") return "error";
  if (status === "checking" || status === "running" || status === "saving") return "updating";
  if (
    hasContent ||
    status === "completed" ||
    status === "cancelled" ||
    status === "saved" ||
    status === "amended"
  ) {
    return "populated";
  }
  return "empty";
}

function availabilityOrUnavailable(
  availability: PanelActionAvailability | undefined,
): PanelActionAvailability {
  return availability ?? { state: "unavailable", reason: FALLBACK_ACTION_UNAVAILABLE };
}

function appErrorOf(
  message: string | undefined,
  code: AppError["code"] = "unavailable",
  retryable = false,
): AppError | null {
  return message === undefined || message.length === 0 ? null : { code, message, retryable };
}

export function panelStateOf(
  model: Pick<
    BtwPanelModel | CleansePanelModel | OmfgPanelModel | PausePanelModel,
    "title" | "lifecycle" | "description" | "error"
  >,
  open: boolean,
  position: "left" | "right" | "inline" = "right",
  readOnly = false,
): PanelState {
  return {
    open,
    lifecycle: model.lifecycle,
    position,
    title: model.title,
    description: model.description,
    error: model.error,
    readOnly,
    pendingUpdates: model.lifecycle === "updating" ? 1 : 0,
  };
}

function rosterAgentOf(roster: AgentRosterStoreSnapshot | undefined, id: string) {
  if (!roster) return undefined;
  for (let index = roster.order.length - 1; index >= 0; index -= 1) {
    const key = roster.order[index];
    const agent = key === undefined ? undefined : roster.agents[key];
    if (agent?.id === id) return agent;
  }
  return undefined;
}

function cleanseAgentOf(
  roster: AgentRosterStoreSnapshot | undefined,
  id: string,
): CleanseAgentProgress {
  const agent = rosterAgentOf(roster, id);
  if (agent === undefined) {
    return {
      id,
      title: id,
      status: "Waiting",
      tone: "neutral",
      step: null,
      duration: null,
    };
  }
  const metrics = readWorkerMetrics(agent.metrics.raw);
  const presentation = statusPresentation(agent.status);
  return {
    id: agent.id,
    title: workerTitle(agent),
    status: presentation.label,
    tone: presentation.tone,
    step: metrics.step,
    duration: metrics.durationMs === null ? null : formatDuration(metrics.durationMs),
  };
}

export function cleanseModelOf(input: CleanseInput): CleansePanelModel {
  const unavailableReason =
    input.status === "unknown" ? (input.message ?? FALLBACK_PANEL_UNAVAILABLE) : undefined;
  const failureMessage =
    input.status === "failed" ? (input.message ?? "The cleanse operation failed.") : undefined;
  const lifecycle = panelLifecycle(
    input.status,
    input.agentIds.length > 0 || input.message !== undefined,
  );
  return {
    title: "Cleanse",
    lifecycle,
    status: input.status,
    description: "Checker and worker progress is local to this app.",
    error:
      input.error ??
      (unavailableReason
        ? appErrorOf(unavailableReason)
        : failureMessage
          ? appErrorOf(failureMessage, "internal", true)
          : null),
    wave: input.wave ?? null,
    totalWaves: input.totalWaves ?? null,
    checker: input.checker ?? null,
    request: input.request ?? null,
    progress: input.progress ?? null,
    message: input.message ?? null,
    agents: input.agentIds.map((id) => cleanseAgentOf(input.roster, id)),
    check: availabilityOrUnavailable(input.check),
    run: availabilityOrUnavailable(input.run),
    cancel: availabilityOrUnavailable(input.cancel),
  };
}

export function btwModelOf(input: {
  readonly turns: readonly BtwTurn[];
  readonly selectedId?: string;
  readonly copy?: PanelActionAvailability;
  readonly cancel?: PanelActionAvailability;
  readonly branch?: PanelActionAvailability;
  readonly error?: AppError | null;
  readonly unavailableReason?: string;
}): BtwPanelModel {
  const selectedId =
    input.selectedId !== undefined && input.turns.some((turn) => turn.id === input.selectedId)
      ? input.selectedId
      : (input.turns.at(-1)?.id ?? null);
  const lifecycle: PanelLifecycle = input.unavailableReason
    ? "unavailable"
    : input.error
      ? "error"
      : input.turns.some((turn) => turn.status === "running")
        ? "updating"
        : input.turns.length > 0
          ? "populated"
          : "empty";
  return {
    title: "Side questions",
    lifecycle,
    description: "Questions stay separate from the chat.",
    error: input.error ?? appErrorOf(input.unavailableReason),
    turns: input.turns,
    selectedId,
    copy: availabilityOrUnavailable(input.copy),
    cancel: availabilityOrUnavailable(input.cancel),
    branch: availabilityOrUnavailable(input.branch),
    unavailableReason: input.unavailableReason,
  };
}

export function omfgModelOf(input: {
  readonly status: OperationStatus;
  readonly complaint: string;
  readonly candidate?: string;
  readonly validation?: readonly string[];
  readonly save?: PanelActionAvailability;
  readonly amend?: PanelActionAvailability;
  readonly cancel?: PanelActionAvailability;
  readonly error?: AppError | null;
  readonly unavailableReason?: string;
}): OmfgPanelModel {
  const lifecycle: PanelLifecycle =
    input.unavailableReason || input.status === "unknown"
      ? "unavailable"
      : input.status === "failed" || input.error
        ? "error"
        : panelLifecycle(input.status, input.candidate !== undefined);
  const errorMessage =
    input.unavailableReason ??
    (input.status === "unknown" ? FALLBACK_PANEL_UNAVAILABLE : undefined) ??
    (input.status === "failed" ? "The rule draft could not be prepared." : undefined);
  return {
    title: "Rule draft",
    lifecycle,
    status: input.status,
    description: "A local preview of the proposed rule; saving is explicit.",
    error:
      input.error ??
      appErrorOf(
        errorMessage,
        input.status === "failed" ? "internal" : "unavailable",
        input.status === "failed",
      ),
    complaint: input.complaint,
    candidate: input.candidate ?? "",
    validation: input.validation ?? [],
    save: availabilityOrUnavailable(input.save),
    amend: availabilityOrUnavailable(input.amend),
    cancel: availabilityOrUnavailable(input.cancel),
  };
}

export function pauseModelOf(input: {
  readonly snapshot: PauseGateSnapshot;
  readonly resume?: PanelActionAvailability;
}): PausePanelModel {
  return {
    title: "Pause screen",
    lifecycle: input.snapshot.open ? "populated" : "empty",
    description: "Pause is local to this app and does not stop omp work.",
    error: null,
    snapshot: input.snapshot,
    resume: availabilityOrUnavailable(input.resume),
  };
}
