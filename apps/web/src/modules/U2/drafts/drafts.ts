import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type AttachmentRef,
  type Draft,
  type DraftChanged,
  type DraftInput,
  type DraftScope,
  DraftStore,
  type FailedSend,
  type PortCallOptions,
  type Revision,
} from "@omp-app/contracts";
import type { PromptIntent } from "../../R0/runtime/runtime";

type DraftCallOptions = Pick<PortCallOptions, "signal">;

const AUTOSAVE_MS = 10_000;

export interface DraftStoreAdapter {
  readonly get: (
    args: { readonly scope: DraftScope },
    options?: DraftCallOptions,
  ) => Promise<{ readonly draft: Draft | null }>;
  readonly save: (
    args: {
      readonly scope: DraftScope;
      readonly draft: DraftInput;
      readonly expectedRevision: Revision | null;
    },
    options?: DraftCallOptions,
  ) => Promise<Draft>;
  readonly clear: (
    args: { readonly scope: DraftScope; readonly expectedRevision: Revision | null },
    options?: DraftCallOptions,
  ) => Promise<{ readonly cleared: boolean; readonly revision: Revision | null }>;
  readonly subscribeChanged?: (
    scope: DraftScope,
    listener: (change: DraftChanged) => void,
  ) => () => void;
}
function draftScopeStream(scope: DraftScope): string {
  return scope.kind === "thread" ? `thread:${scope.threadId}` : `folder:${scope.folder}`;
}

/** Adapts A0.8's typed AppClient to the browser DraftStoreController seam. */
export function createDraftStoreAdapter(client: AppClient): DraftStoreAdapter {
  const port = client.port(DraftStore);
  return {
    get: (args, options) => port.get(args, options),
    save: (args, options) => port.save(args, options),
    clear: (args, options) => port.clear(args, options),
    subscribeChanged: (scope, listener) => {
      let active = true;
      let removeListener: (() => void) | undefined;
      let subscription: { readonly unsubscribe: () => Promise<void> } | undefined;
      const pending = client
        .subscribe(DraftStore, "changed", { scope: draftScopeStream(scope) })
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

export interface DraftTimer {
  readonly setTimeout: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface DraftLifecycleTarget {
  readonly document?: { readonly visibilityState?: string };
  addEventListener(type: "visibilitychange" | "pagehide", listener: () => void): void;
  removeEventListener(type: "visibilitychange" | "pagehide", listener: () => void): void;
}

export interface DraftControllerOptions {
  readonly store: DraftStoreAdapter;
  readonly scope: DraftScope;
  readonly lifecycle?: DraftLifecycleTarget;
  readonly timers?: DraftTimer;
  readonly now?: () => Date;
}

export type DraftStatus = "idle" | "loading" | "ready" | "saving" | "conflict" | "error";

export interface DraftConflict {
  readonly local: DraftInput;
  readonly remote: Draft | null;
}

export interface DraftSnapshot {
  readonly scope: DraftScope;
  readonly status: DraftStatus;
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  readonly failedSends: readonly FailedSend[];
  readonly revision: Revision | null;
  readonly dirty: boolean;
  readonly conflict: DraftConflict | null;
  readonly error: AppFailure | null;
}

export type DraftListener = (snapshot: DraftSnapshot) => void;

const defaultTimers: DraftTimer = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({ code: "internal", message: fallback, retryable: true }, { cause: error });
}
function draftInput(
  text: string,
  attachments: readonly AttachmentRef[],
  failedSends: readonly FailedSend[],
): DraftInput {
  return { text, attachments: [...attachments], failedSends: [...failedSends] };
}

function sameScope(left: DraftScope, right: DraftScope): boolean {
  if (left.kind === "thread" && right.kind === "thread") return left.threadId === right.threadId;
  if (left.kind === "folder" && right.kind === "folder") return left.folder === right.folder;
  return false;
}

function scrubFailureReason(error: unknown): string {
  if (error instanceof AppFailure) return error.appError.message;
  return "Prompt submission failed before admission";
}

/** Draft state machine for one thread/folder scope; DraftStore remains the authority. */
export class DraftController {
  private readonly store: DraftStoreAdapter;
  private readonly timers: DraftTimer;
  private readonly now: () => Date;
  private lifecycle: DraftLifecycleTarget | undefined;
  private readonly onPageHide = (): void => this.flushLifecycle();
  private readonly onVisibilityChange = (): void => {
    if (this.lifecycle?.document?.visibilityState === "visible") return;
    this.flushLifecycle();
  };
  private scope: DraftScope;
  private snapshot: DraftSnapshot;
  private readonly listeners = new Set<DraftListener>();
  private timer: unknown;
  private unsubscribeChanged: (() => void) | undefined;

  public constructor(options: DraftControllerOptions) {
    this.store = options.store;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => new Date());
    this.scope = options.scope;
    this.lifecycle = options.lifecycle;
    this.snapshot = {
      scope: options.scope,
      status: "idle",
      text: "",
      attachments: [],
      failedSends: [],
      revision: null,
      dirty: false,
      conflict: null,
      error: null,
    };
    this.attachLifecycle();
    this.subscribeToChanges();
  }

  public getSnapshot(): DraftSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: DraftListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(): Promise<DraftSnapshot> {
    this.setState({ status: "loading", error: null });
    try {
      const result = await this.store.get({ scope: this.scope });
      if (result.draft === null) {
        this.setState({
          status: "ready",
          text: "",
          attachments: [],
          failedSends: [],
          revision: null,
          dirty: false,
          conflict: null,
          error: null,
        });
      } else {
        this.setState({
          status: "ready",
          text: result.draft.text,
          attachments: [...result.draft.attachments],
          failedSends: [...result.draft.failedSends],
          revision: result.draft.revision,
          dirty: false,
          conflict: null,
          error: null,
        });
      }
      return this.snapshot;
    } catch (error) {
      const appError = failure(error, "Loading the draft failed");
      this.setState({ status: "error", error: appError });
      throw appError;
    }
  }

  public async switchScope(scope: DraftScope): Promise<DraftSnapshot> {
    await this.flush();
    this.unsubscribeChanged?.();
    this.scope = scope;
    this.setState({
      scope,
      status: "idle",
      text: "",
      attachments: [],
      failedSends: [],
      revision: null,
      dirty: false,
      conflict: null,
      error: null,
    });
    this.subscribeToChanges();
    return this.load();
  }

  public setDraft(text: string, attachments: readonly AttachmentRef[]): void {
    this.setState({
      text,
      attachments: [...attachments],
      dirty: true,
      status: "ready",
      error: null,
      conflict: null,
    });
    this.scheduleSave();
  }

  /** P6's dequeue-to-edit seam: update the live draft, then let autosave persist it. */
  public restoreDraft(text: string, attachments: readonly AttachmentRef[]): void {
    this.setDraft(text, attachments);
  }

  public async flush(): Promise<void> {
    this.clearTimer();
    if (!this.snapshot.dirty || this.snapshot.conflict !== null) return;
    await this.saveCurrent();
  }

  /** Submit clears the draft only after the injected R0.3 callback resolves at admission. */
  public async submit(
    intent: PromptIntent,
    submitPrompt: (intent: PromptIntent) => Promise<void>,
  ): Promise<void> {
    this.setDraft(intent.text, intent.attachmentRefs ?? []);
    try {
      await submitPrompt(intent);
      await this.clearAfterAdmission();
    } catch (error) {
      await this.recordFailedSend(intent, error);
      throw error;
    }
  }

  public async clearAfterAdmission(): Promise<void> {
    if (this.snapshot.revision === null && !this.snapshot.dirty) return;
    this.clearTimer();
    try {
      const result = await this.store.clear({
        scope: this.scope,
        expectedRevision: this.snapshot.revision,
      });
      if (!result.cleared) {
        await this.handleConflict("The draft changed before it could be cleared");
        return;
      }
      this.setState({
        text: "",
        attachments: [],
        revision: result.revision,
        dirty: false,
        failedSends: [],
        conflict: null,
        status: "ready",
        error: null,
      });
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict") {
        await this.handleConflict("The draft changed before it could be cleared");
      } else {
        const appError = failure(error, "Clearing the draft failed");
        this.setState({ status: "error", error: appError });
        throw appError;
      }
    }
  }

  public async resolveConflict(
    choice: "local" | "remote" | "merged",
    merged?: { readonly text: string; readonly attachments: readonly AttachmentRef[] },
  ): Promise<void> {
    const conflict = this.snapshot.conflict;
    if (conflict === null) {
      throw new AppFailure({
        code: "invalid_args",
        message: "No draft conflict is pending",
        retryable: false,
      });
    }
    if (choice === "remote") {
      if (conflict.remote === null) {
        this.setState({
          text: "",
          attachments: [],
          failedSends: [],
          revision: null,
          dirty: false,
          conflict: null,
          status: "ready",
          error: null,
        });
      } else {
        this.setState({
          text: conflict.remote.text,
          attachments: [...conflict.remote.attachments],
          failedSends: [...conflict.remote.failedSends],
          revision: conflict.remote.revision,
          dirty: false,
          conflict: null,
          status: "ready",
          error: null,
        });
      }
      return;
    }
    const local = choice === "merged" ? merged : conflict.local;
    if (!local) {
      throw new AppFailure({
        code: "invalid_args",
        message: "Merged draft contents are required",
        retryable: false,
      });
    }
    this.setState({
      text: local.text,
      attachments: [...local.attachments],
      failedSends: [...conflict.local.failedSends],
      revision: conflict.remote?.revision ?? null,
      dirty: true,
      conflict: null,
      status: "ready",
      error: null,
    });
    await this.flush();
  }

  public async dispose(): Promise<void> {
    this.unsubscribeChanged?.();
    this.unsubscribeChanged = undefined;
    this.detachLifecycle();
    await this.flush();
    this.listeners.clear();
  }

  private scheduleSave(): void {
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) => {
        this.setState({ status: "error", error: failure(error, "Saving the draft failed") });
      });
    }, AUTOSAVE_MS);
  }

  private async saveCurrent(): Promise<void> {
    if (!this.snapshot.dirty || this.snapshot.conflict !== null) return;
    const input = draftInput(
      this.snapshot.text,
      this.snapshot.attachments,
      this.snapshot.failedSends,
    );
    this.setState({ status: "saving", error: null });
    try {
      const saved = await this.store.save({
        scope: this.scope,
        draft: input,
        expectedRevision: this.snapshot.revision,
      });
      this.setState({
        scope: saved.scope,
        status: "ready",
        revision: saved.revision,
        dirty: false,
        conflict: null,
        error: null,
      });
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict") {
        await this.handleConflict("The draft changed in another tab");
      } else {
        const appError = failure(error, "Saving the draft failed");
        this.setState({ status: "error", error: appError });
        throw appError;
      }
    }
  }

  private async recordFailedSend(intent: PromptIntent, error: unknown): Promise<void> {
    const failed: FailedSend = {
      attemptedAt: this.now().toISOString(),
      text: intent.text,
      attachments: [...(intent.attachmentRefs ?? [])],
      reason: scrubFailureReason(error),
    };
    this.setState({
      failedSends: [...this.snapshot.failedSends, failed],
      dirty: true,
      status: "ready",
    });
    try {
      await this.flush();
    } catch {
      // The original admission failure remains the caller's error; state.error reports persistence failure.
    }
  }

  private async handleConflict(message: string): Promise<void> {
    const result = await this.store.get({ scope: this.scope });
    this.setState({
      status: "conflict",
      conflict: {
        local: draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends),
        remote: result.draft,
      },
      error: new AppFailure({ code: "conflict", message, retryable: true }),
    });
  }

  private subscribeToChanges(): void {
    if (!this.store.subscribeChanged) return;
    this.unsubscribeChanged = this.store.subscribeChanged(this.scope, (change) => {
      if (!sameScope(change.scope, this.scope)) return;
      if (change.draft === null) {
        if (this.snapshot.dirty) {
          this.setState({
            status: "conflict",
            conflict: {
              local: draftInput(
                this.snapshot.text,
                this.snapshot.attachments,
                this.snapshot.failedSends,
              ),
              remote: null,
            },
            error: new AppFailure({
              code: "conflict",
              message: "The draft was cleared in another tab",
              retryable: true,
            }),
          });
        } else {
          this.setState({
            text: "",
            attachments: [],
            failedSends: [],
            revision: null,
            dirty: false,
            status: "ready",
            conflict: null,
            error: null,
          });
        }
        return;
      }
      if (change.draft.revision === this.snapshot.revision) return;
      if (this.snapshot.dirty) {
        this.setState({
          status: "conflict",
          conflict: {
            local: draftInput(
              this.snapshot.text,
              this.snapshot.attachments,
              this.snapshot.failedSends,
            ),
            remote: change.draft,
          },
          error: new AppFailure({
            code: "conflict",
            message: "The draft changed in another tab",
            retryable: true,
          }),
        });
      } else {
        this.setState({
          text: change.draft.text,
          attachments: [...change.draft.attachments],
          failedSends: [...change.draft.failedSends],
          revision: change.draft.revision,
          dirty: false,
          status: "ready",
          conflict: null,
          error: null,
        });
      }
    });
  }

  private attachLifecycle(): void {
    if (!this.lifecycle) return;
    this.lifecycle.addEventListener("pagehide", this.onPageHide);
    this.lifecycle.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private detachLifecycle(): void {
    if (!this.lifecycle) return;
    this.lifecycle.removeEventListener("pagehide", this.onPageHide);
    this.lifecycle.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private flushLifecycle(): void {
    void this.flush().catch((error) => {
      this.setState({ status: "error", error: failure(error, "Saving the draft failed") });
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private setState(update: Partial<DraftSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
