import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type PlanDocument,
  type PlanDocumentInput,
  PlanDocumentStore as PlanDocumentStorePort,
  type PlanExportResult,
  type PlanLoadResult,
  type PlanRevision,
  type PlanSaveResult,
  type PlanSection,
  type ThreadId,
} from "@omp-app/contracts";

export type {
  PlanAnnotation,
  PlanDocument,
  PlanDocumentInput,
  PlanDocumentStatus,
  PlanRevision,
  PlanSection,
} from "@omp-app/contracts";

export interface PlanDocumentStoreAdapter {
  readonly load: (
    threadId: ThreadId,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PlanLoadResult>;
  readonly save: (
    document: PlanDocumentInput,
    expectedRevision: number,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PlanSaveResult>;
  readonly export: (
    documentId: PlanDocument["id"],
    format: "markdown" | "json",
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PlanExportResult>;
  readonly subscribeChanged: (
    threadId: ThreadId,
    listener: (change: PlanChanged) => void,
  ) => () => void;
}

export interface PlanChanged {
  readonly threadId: ThreadId;
  readonly document: PlanDocument;
  readonly revisions: readonly PlanRevision[];
}

export interface PlanState {
  readonly threadId: ThreadId;
  readonly document: PlanDocument | null;
  readonly revisions: readonly PlanRevision[];
  readonly mode: "off" | "planning" | "review" | "executing";
  readonly authority: "host" | "upstream";
  readonly pendingAction: "load" | "save" | null;
  readonly isDirty: boolean;
  readonly selectedSectionId: string | null;
  readonly toc: readonly PlanSection[];
  readonly capabilityReason?: string;
  readonly conflict: PlanDocument | null;
  readonly error: AppFailure | null;
}

export interface PlanDocumentStoreSource {
  readonly load: PlanDocumentStoreAdapter["load"];
  readonly save: PlanDocumentStoreAdapter["save"];
  readonly export: PlanDocumentStoreAdapter["export"];
  readonly subscribeChanged: PlanDocumentStoreAdapter["subscribeChanged"];
}

function asFailure(error: unknown, message: string): AppFailure {
  return error instanceof AppFailure
    ? error
    : new AppFailure({ code: "internal", message, retryable: true }, { cause: error });
}

function modeFor(document: PlanDocument | null): PlanState["mode"] {
  if (document === null) return "off";
  if (document.status === "executing") return "executing";
  if (
    document.status === "review" ||
    document.status === "approved" ||
    document.status === "rejected"
  )
    return "review";
  return "planning";
}

/** Wraps A1.20 through A0.8's typed client port and scopes changed events to one thread. */
export function createPlanDocumentStoreAdapter(client: AppClient): PlanDocumentStoreAdapter {
  const port = client.port(PlanDocumentStorePort);
  return {
    load: (threadId, options) => port.load({ threadId }, options),
    save: (document, expectedRevision, options) =>
      port.save({ document, expectedRevision }, options),
    export: (documentId, format, options) => port.export({ documentId, format }, options),
    subscribeChanged: (threadId, listener) => {
      let active = true;
      let removeListener: (() => void) | undefined;
      let subscription: { readonly unsubscribe: () => Promise<void> } | undefined;
      const pending = client
        .subscribe(PlanDocumentStorePort, "changed", { scope: String(threadId) })
        .then((next) => {
          subscription = next;
          if (!active) {
            void next.unsubscribe();
            return;
          }
          removeListener = next.onEvent((payload) => listener(payload));
        })
        .catch(() => undefined);
      return () => {
        active = false;
        removeListener?.();
        void pending.then(() => subscription?.unsubscribe()).catch(() => undefined);
      };
    },
  };
}

/** Browser plan state over A1.20: stale save conflicts re-read and never overwrite. */
export class PlanStateController {
  private readonly store: PlanDocumentStoreSource;
  private readonly listeners = new Set<(state: PlanState) => void>();
  private readonly unsubscribeChanged: () => void;
  private state: PlanState;

  public constructor(options: {
    readonly store: PlanDocumentStoreSource;
    readonly threadId: ThreadId;
    readonly authority?: PlanState["authority"];
    readonly capabilityReason?: string;
  }) {
    this.store = options.store;
    this.state = {
      threadId: options.threadId,
      document: null,
      revisions: [],
      mode: "off",
      authority: options.authority ?? "host",
      pendingAction: null,
      isDirty: false,
      selectedSectionId: null,
      toc: [],
      ...(options.capabilityReason === undefined
        ? {}
        : { capabilityReason: options.capabilityReason }),
      conflict: null,
      error: null,
    };
    this.unsubscribeChanged = this.store.subscribeChanged(options.threadId, (change) =>
      this.onChanged(change),
    );
  }

  public getSnapshot(): PlanState {
    return this.state;
  }

  public subscribe(listener: (state: PlanState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(options?: { readonly signal?: AbortSignal }): Promise<PlanState> {
    this.update({ pendingAction: "load", error: null });
    try {
      const result = await this.store.load(this.state.threadId, options);
      this.state = this.stateFrom(result.document, result.revisions, {
        isDirty: false,
        conflict: null,
      });
      this.notify();
      return this.state;
    } catch (error) {
      const failure = asFailure(error, "Loading the plan document failed");
      this.update({ pendingAction: null, error: failure });
      throw failure;
    }
  }

  public async save(
    document: PlanDocumentInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlanState> {
    const expectedRevision = this.state.document?.revision ?? 0;
    this.update({ pendingAction: "save", error: null, isDirty: true });
    try {
      const result = await this.store.save(document, expectedRevision, options);
      this.state = this.stateFrom(result.document, result.revisions, {
        isDirty: false,
        conflict: null,
      });
      this.notify();
      return this.state;
    } catch (error) {
      const failure = asFailure(error, "Saving the plan document failed");
      if (failure.appError.code === "conflict") {
        const fresh = await this.store.load(this.state.threadId, options);
        this.state = this.stateFrom(fresh.document, fresh.revisions, {
          isDirty: true,
          conflict: fresh.document,
          error: failure,
        });
        this.notify();
      } else {
        this.update({ pendingAction: null, error: failure });
      }
      throw failure;
    }
  }

  public dispose(): void {
    this.unsubscribeChanged();
    this.listeners.clear();
  }

  private onChanged(change: PlanChanged): void {
    if (change.threadId !== this.state.threadId) return;
    this.state = this.stateFrom(change.document, change.revisions, {
      isDirty: this.state.isDirty,
      conflict: this.state.isDirty ? change.document : null,
      error: this.state.isDirty ? this.state.error : null,
    });
    this.notify();
  }

  private stateFrom(
    document: PlanDocument | null,
    revisions: readonly PlanRevision[],
    patch: Pick<PlanState, "isDirty" | "conflict"> & { readonly error?: AppFailure | null },
  ): PlanState {
    return {
      ...this.state,
      document,
      revisions,
      mode: modeFor(document),
      pendingAction: null,
      toc: document?.sections ?? [],
      isDirty: patch.isDirty,
      conflict: patch.conflict,
      error: patch.error ?? null,
    };
  }

  private update(patch: Partial<PlanState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
