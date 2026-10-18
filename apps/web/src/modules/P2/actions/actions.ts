/**
 * omp v18.9.1 exposes prompt/abort and conversation branch/fork RPCs, but no plan
 * approve/refine/execute/cancel commands (`packages/coding-agent/src/modes/rpc/wire/commands.ts:41-73,266-282`).
 * P2 therefore keeps document refinement host-owned and gates the other actions on
 * the future typed upstream plan-mode capability instead of sending a normal prompt.
 */
import type {
  CapabilityStatus,
  PlanDocument,
  PlanDocumentInput,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { PlanState, PlanStateController } from "../contract";

export const PLAN_MODE_CAPABILITY = "upstream.plan-mode" as const;
export type PlanAction = "approve" | "refine" | "execute" | "cancel";
export type PlanActionAuthority = "host" | "upstream";

export interface PlanActionAvailability {
  readonly action: PlanAction;
  readonly authority: PlanActionAuthority;
  readonly enabled: boolean;
  readonly reason: string | null;
}

export interface UpstreamPlanActionPort {
  readonly approve: (
    threadId: ThreadId,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PlanActionResult>;
  readonly execute: (
    threadId: ThreadId,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PlanActionResult>;
  readonly cancel: (
    threadId: ThreadId,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PlanActionResult>;
}

export interface PlanActionResult {
  readonly action: PlanAction;
  readonly authority: PlanActionAuthority;
  readonly status: "approved" | "refined" | "executed" | "cancelled";
  readonly document: PlanDocument | null;
}

export interface PlanActionControllerOptions {
  readonly plan: PlanStateController;
  readonly upstream?: UpstreamPlanActionPort;
  readonly upstreamCapability?: CapabilityStatus;
}

const UNAVAILABLE_REASON =
  "omp does not provide authoritative plan actions here yet. Save or refine the host plan, then use plan controls in omp's terminal.";

function unavailable(reason = UNAVAILABLE_REASON): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: reason,
    retryable: false,
    capability: PLAN_MODE_CAPABILITY,
  });
}

function actionNeedsDocument(state: PlanState): PlanDocument {
  if (state.document === null) {
    throw new AppFailure({
      code: "invalid_args",
      message: "Create and save a plan before using plan review actions.",
      retryable: false,
    });
  }
  return state.document;
}

/** Returns the authority and visible capability reason for every review action. */
export function planActionAvailability(
  capability?: PlanActionControllerOptions["upstreamCapability"],
): readonly PlanActionAvailability[] {
  const upstreamAvailable = capability?.state === "available" && capability.via === "upstream";
  const reason = upstreamAvailable ? null : (capability?.detail ?? UNAVAILABLE_REASON);
  return [
    { action: "approve", authority: "upstream", enabled: upstreamAvailable, reason },
    { action: "refine", authority: "host", enabled: true, reason: null },
    { action: "execute", authority: "upstream", enabled: upstreamAvailable, reason },
    { action: "cancel", authority: "upstream", enabled: upstreamAvailable, reason },
  ];
}

/**
 * Host refinement is a document CAS save. Approve, execute and cancel only call the
 * typed upstream seam when omp advertises the plan-mode capability; none becomes a prompt fallback.
 */
export interface PlanActionController {
  availability(): readonly PlanActionAvailability[];
  refine(
    document: PlanDocumentInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlanActionResult>;
  approve(options?: { readonly signal?: AbortSignal }): Promise<PlanActionResult>;
  execute(options?: { readonly signal?: AbortSignal }): Promise<PlanActionResult>;
  cancel(options?: { readonly signal?: AbortSignal }): Promise<PlanActionResult>;
}

class PlanActionControllerImpl implements PlanActionController {
  private readonly plan: PlanStateController;
  private readonly upstream: UpstreamPlanActionPort | undefined;
  private readonly capability: PlanActionControllerOptions["upstreamCapability"];

  public constructor(options: PlanActionControllerOptions) {
    this.plan = options.plan;
    this.upstream = options.upstream;
    this.capability = options.upstreamCapability;
  }

  public availability(): readonly PlanActionAvailability[] {
    return planActionAvailability(this.capability);
  }

  public async refine(
    document: PlanDocumentInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlanActionResult> {
    const state = await this.plan.save(document, options);
    return {
      action: "refine",
      authority: "host",
      status: "refined",
      document: state.document,
    };
  }

  public approve(options?: { readonly signal?: AbortSignal }): Promise<PlanActionResult> {
    return this.callUpstream("approve", options);
  }

  public execute(options?: { readonly signal?: AbortSignal }): Promise<PlanActionResult> {
    return this.callUpstream("execute", options);
  }

  public cancel(options?: { readonly signal?: AbortSignal }): Promise<PlanActionResult> {
    return this.callUpstream("cancel", options);
  }

  private async callUpstream(
    action: Exclude<PlanAction, "refine">,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlanActionResult> {
    const document = actionNeedsDocument(this.plan.getSnapshot());
    if (
      this.capability?.state !== "available" ||
      this.capability.via !== "upstream" ||
      this.upstream === undefined
    ) {
      throw unavailable();
    }
    const result = await this.upstream[action](document.threadId, options);
    const expectedStatus =
      action === "approve" ? "approved" : action === "execute" ? "executed" : "cancelled";
    if (
      result.action !== action ||
      result.authority !== "upstream" ||
      result.status !== expectedStatus
    ) {
      throw new AppFailure({
        code: "conflict",
        message: "The plan action response did not match the requested action.",
        retryable: true,
      });
    }
    return result;
  }
}

/** Creates the action controller for the P2 review composition seam. */
export function createPlanActionController(
  options: PlanActionControllerOptions,
): PlanActionController {
  return new PlanActionControllerImpl(options);
}
