import {
  AppFailure,
  type CapabilityStatus,
  type PlanDocumentInput,
  type PortCallOptions,
  type ThreadId,
} from "@omp-app/contracts";
import type { PlanDocumentStoreSource, PlanState } from "../contract";
import { PlanStateController } from "../contract";

/** AP6 seam: omp v18.6.1 has no typed plan-mode RPC; a future port may provide these calls. */
export interface PlanModePort {
  readonly enter: (threadId: ThreadId, options?: PortCallOptions) => Promise<void>;
  readonly exit: (threadId: ThreadId, options?: PortCallOptions) => Promise<void>;
}

export interface PlanModeState {
  readonly threadId: ThreadId;
  readonly mode: PlanState["mode"];
  readonly authority: PlanState["authority"];
  readonly document: PlanState["document"];
  readonly revisions: PlanState["revisions"];
  readonly isDirty: boolean;
  readonly pending: boolean;
  readonly canToggle: boolean;
  readonly capabilityReason: string | null;
  readonly error: AppFailure | null;
}

export interface PlanModeControllerOptions {
  readonly store: PlanDocumentStoreSource;
  readonly threadId: ThreadId;
  readonly port?: PlanModePort;
  readonly capability?: CapabilityStatus;
}

function unavailableReason(capability?: CapabilityStatus): string {
  if (capability?.detail) return capability.detail;
  return "Plan mode can only be switched in the omp terminal for now.";
}

function unavailable(capabilityReason: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: capabilityReason,
    retryable: false,
    capability: "upstream.plan-mode",
  });
}

/** Host draft/planning state: persistence works through A1.20 while authoritative mode is AP6-gated. */
export class PlanModeController {
  private readonly plan: PlanStateController;
  private readonly threadId: ThreadId;
  private readonly port: PlanModePort | undefined;
  private readonly capability: CapabilityStatus | undefined;
  private readonly listeners = new Set<(state: PlanModeState) => void>();
  private readonly unsubscribePlan: () => void;
  private state: PlanModeState;
  private pending = false;
  private error: AppFailure | null = null;

  public constructor(options: PlanModeControllerOptions) {
    this.plan = new PlanStateController({
      store: options.store,
      threadId: options.threadId,
      capabilityReason: unavailableReason(options.capability),
    });
    this.threadId = options.threadId;
    this.port = options.port;
    this.capability = options.capability;
    this.state = this.project(this.plan.getSnapshot());
    this.unsubscribePlan = this.plan.subscribe((next) => {
      this.state = this.project(next);
      this.notify();
    });
  }

  public getSnapshot(): PlanModeState {
    return this.state;
  }

  public subscribe(listener: (state: PlanModeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(options?: { readonly signal?: AbortSignal }): Promise<PlanModeState> {
    await this.plan.load(options);
    return this.state;
  }

  public async saveDraft(
    document: PlanDocumentInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlanModeState> {
    await this.plan.save(document, options);
    return this.state;
  }

  public async toggle(options?: PortCallOptions): Promise<PlanModeState> {
    const available = this.port !== undefined && this.capability?.state === "available";
    if (!available) {
      const failure = unavailable(
        this.state.capabilityReason ?? unavailableReason(this.capability),
      );
      this.error = failure;
      this.state = this.project(this.plan.getSnapshot());
      this.notify();
      throw failure;
    }
    this.pending = true;
    this.error = null;
    this.state = this.project(this.plan.getSnapshot());
    this.notify();
    try {
      if (this.state.mode === "planning") await this.port.exit(this.threadId, options);
      else await this.port.enter(this.threadId, options);
      return this.state;
    } catch (error) {
      const failure =
        error instanceof AppFailure
          ? error
          : new AppFailure(
              { code: "internal", message: "Plan mode transition failed.", retryable: true },
              { cause: error },
            );
      this.error = failure;
      throw failure;
    } finally {
      this.pending = false;
      this.state = this.project(this.plan.getSnapshot());
      this.notify();
    }
  }

  public dispose(): void {
    this.unsubscribePlan();
    this.plan.dispose();
    this.listeners.clear();
  }

  private project(plan: PlanState): PlanModeState {
    const canToggle = this.port !== undefined && this.capability?.state === "available";
    return {
      threadId: this.threadId,
      mode: plan.mode,
      authority: canToggle ? "upstream" : "host",
      document: plan.document,
      revisions: plan.revisions,
      isDirty: plan.isDirty,
      pending: this.pending,
      canToggle,
      capabilityReason: canToggle
        ? null
        : (plan.capabilityReason ?? unavailableReason(this.capability)),
      error: this.error ?? plan.error,
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
