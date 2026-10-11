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
import { composerTextForIntent } from "../modes";
import type { BufferedDraft, DraftBuffer } from "./draft-buffer";

type DraftCallOptions = Pick<PortCallOptions, "signal">;

const AUTOSAVE_MS = 10_000;

const MOVE_CONFLICT = "The draft changed in another tab before it could move";
type FailedStep = "load" | "save" | "clear";

/**
 * Writes this app is still making, by scope. A controller that loads a scope waits for them first, so a
 * draft flushed as the person leaves a chat is the one the next chat that opens the same scope reads.
 */
const pendingWrites = new Map<string, Promise<void>>();

function trackWrite<T>(scope: DraftScope, write: Promise<T>): Promise<T> {
  const key = draftScopeStream(scope);
  const settled = write.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(key, settled);
  void settled.then(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
  return write;
}

async function settledWrites(scope: DraftScope): Promise<void> {
  await pendingWrites.get(draftScopeStream(scope));
}

/** What a scope held, handed to another scope when the chat's draft moves. */
export interface HeldDraft {
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
  readonly failedSends: readonly FailedSend[];
}

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
export function draftScopeStream(scope: DraftScope): string {
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
  /** Keeps the text this scope has not saved yet in this tab, so it survives the app's server stopping. */
  readonly buffer?: DraftBuffer;
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
  /** The draft that text typed before this scope loaded replaced: kept until it is restored or dismissed. */
  readonly replaced: DraftInput | null;
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

export function isConflictFailure(error: unknown): boolean {
  return error instanceof AppFailure && error.appError.code === "conflict";
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

/** Two drafts' text, the first then the second with a blank line between; attachments and failed sends in order, once each. */
function combineDrafts(first: DraftInput, second: DraftInput): DraftInput {
  const text =
    first.text === ""
      ? second.text
      : second.text === ""
        ? first.text
        : `${first.text}\n\n${second.text}`;
  return {
    text,
    attachments: distinctBy([...first.attachments, ...second.attachments]),
    failedSends: distinctBy([...first.failedSends, ...second.failedSends]),
  };
}

/** The items, each kept once by its content. */
function distinctBy<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameInput(left: DraftInput, right: DraftInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Draft state machine for one thread/folder scope; DraftStore remains the authority. */
export class DraftController {
  private readonly store: DraftStoreAdapter;
  private readonly timers: DraftTimer;
  private readonly now: () => Date;
  private readonly buffer: DraftBuffer | undefined;
  /** True from the start of a load until the buffered text is read: the controller must not overwrite it first. */
  private loading = false;
  /** The load in progress, if any: a second call while it runs gets the same promise. */
  private loadInFlight: Promise<DraftSnapshot> | undefined;
  /** Whether the draft has loaded: a save loads it first, so the save carries the revision the store holds. */
  private loaded = false;
  /** The text of the save this controller sent and has not heard back about; the buffer keeps it until it lands. */
  private saving: DraftInput | null = null;
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
  /** The step the error status is for: the composer's Retry runs it again. */
  private failedStep: FailedStep | null = null;

  public constructor(options: DraftControllerOptions) {
    this.store = options.store;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => new Date());
    this.buffer = options.buffer;
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
      replaced: null,
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

  /** Loads the scope. Loads started together, as StrictMode's double-run effects start them, share one load. */
  public load(): Promise<DraftSnapshot> {
    this.loadInFlight ??= this.loadNow().finally(() => {
      this.loadInFlight = undefined;
    });
    return this.loadInFlight;
  }

  private async loadNow(): Promise<DraftSnapshot> {
    // A controller that already holds text is the authority: the buffer only mirrors that text, so it is not
    // restored over it again (a load repeats when the composer's controller changes, after a restore).
    const holdsText = this.snapshot.dirty;
    this.loading = true;
    const replaced =
      this.buffer === undefined ? this.snapshot.replaced : this.buffer.readReplaced(this.scope);
    this.setState({ status: "loading", error: null, replaced });
    let held: BufferedDraft | null = null;
    try {
      await settledWrites(this.scope);
      // Read once the writes in flight have landed: the buffer then holds what the store is about to return.
      held = holdsText ? null : (this.buffer?.read(this.scope) ?? null);
      const result = await this.store.get({ scope: this.scope });
      this.loading = false;
      this.loaded = true;
      if (held !== null) {
        this.restore(held, result.draft);
        return this.snapshot;
      }
      if (this.snapshot.dirty) {
        // The person typed while this was loading. Their text is newer than the stored draft, so it stays. The stored
        // draft is kept for the person to restore, because the next save replaces it. The stored revision is adopted
        // so the next save is not taken for a conflict.
        const stored = result.draft;
        this.setState({
          status: "ready",
          failedSends: stored === null ? [] : [...stored.failedSends],
          replaced: stored === null ? this.snapshot.replaced : this.keepReplaced(stored),
          revision: stored === null ? null : stored.revision,
          conflict: null,
          error: null,
        });
        return this.snapshot;
      }
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
      this.loading = false;
      this.keepUnsavedOnFailure(held);
      const appError = failure(error, "Loading the draft failed");
      this.fail("load", appError);
      throw appError;
    }
  }

  public setDraft(text: string, attachments: readonly AttachmentRef[]): void {
    const conflict = this.snapshot.conflict;
    this.setState({
      text,
      attachments: [...attachments],
      dirty: true,
      // A conflict stays on screen until a choice is made: its local side is what was typed last. Nothing is saved
      // over the other tab's draft before then (flush does not save while a conflict shows).
      status: conflict === null ? "ready" : "conflict",
      error: conflict === null ? null : this.snapshot.error,
      conflict:
        conflict === null
          ? null
          : { ...conflict, local: draftInput(text, attachments, this.snapshot.failedSends) },
    });
    this.scheduleSave();
  }

  /** P6's dequeue-to-edit seam: update the live draft, then let autosave persist it. */
  public restoreDraft(text: string, attachments: readonly AttachmentRef[]): void {
    this.setDraft(text, attachments);
  }

  /**
   * Puts the draft that text typed before the scope loaded replaced back in front of the text typed since
   * ("restore"), or forgets it ("dismiss"). Restoring is the person's choice: the text is saved as a draft, not sent.
   */
  public resolveReplaced(choice: "restore" | "dismiss"): void {
    const replaced = this.snapshot.replaced;
    if (replaced === null) return;
    this.buffer?.clearReplaced(this.scope);
    if (choice === "dismiss") {
      this.setState({ replaced: null });
      return;
    }
    const typed = draftInput(
      this.snapshot.text,
      this.snapshot.attachments,
      this.snapshot.failedSends,
    );
    const merged = combineDrafts(replaced, typed);
    this.setState({ replaced: null, failedSends: merged.failedSends });
    this.setDraft(merged.text, merged.attachments);
  }

  /**
   * The stored draft that the next save would replace is kept for the person to restore, after any draft already kept
   * for this scope. Nothing is kept for a stored draft this controller has already shown, for an empty one, or for one
   * the typed text equals: nothing typed or stored would be lost. Returns what is kept now.
   */
  private keepReplaced(stored: Draft): DraftInput | null {
    const earlier = this.snapshot.replaced;
    const kept = draftInput(stored.text, stored.attachments, []);
    const typed = draftInput(this.snapshot.text, this.snapshot.attachments, []);
    const hasContent = kept.text !== "" || kept.attachments.length > 0;
    if (stored.revision === this.snapshot.revision || !hasContent || sameInput(kept, typed)) {
      return earlier;
    }
    const replaced = earlier === null ? kept : combineDrafts(earlier, kept);
    this.buffer?.writeReplaced(this.scope, replaced);
    return replaced;
  }

  /**
   * Empties this scope and returns what it held, so the chat's draft can move to another scope with
   * nothing left here to reappear later. Waits for this scope's writes in flight first, so the revision
   * it removes is the current one.
   */
  public async handOff(): Promise<HeldDraft> {
    await settledWrites(this.scope);
    if (this.snapshot.conflict !== null) {
      throw new AppFailure({
        code: "conflict",
        message: "The draft has a conflict to resolve before it can move",
        retryable: true,
      });
    }
    this.clearTimer();
    const held: HeldDraft = {
      text: this.snapshot.text,
      attachments: [...this.snapshot.attachments],
      failedSends: [...this.snapshot.failedSends],
    };
    if (this.snapshot.revision !== null) {
      const cleared = await trackWrite(
        this.scope,
        this.store.clear({ scope: this.scope, expectedRevision: this.snapshot.revision }),
      ).then(
        (result) => result.cleared,
        (error: unknown) => {
          if (isConflictFailure(error)) return false;
          throw error;
        },
      );
      if (!cleared) {
        // The draft changed in another tab: its choices are shown here, and the move waits for one of them.
        await this.handleConflict(MOVE_CONFLICT);
        throw new AppFailure({ code: "conflict", message: MOVE_CONFLICT, retryable: true });
      }
    }
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
    return held;
  }

  /** Adds a draft that moved here from another scope; the text already here stays first. */
  public adopt(held: HeldDraft): void {
    if (held.text === "" && held.attachments.length === 0 && held.failedSends.length === 0) return;
    const text =
      this.snapshot.text === ""
        ? held.text
        : held.text === ""
          ? this.snapshot.text
          : `${this.snapshot.text}\n\n${held.text}`;
    this.setState({
      text,
      attachments: [...this.snapshot.attachments, ...held.attachments],
      failedSends: [...this.snapshot.failedSends, ...held.failedSends],
      dirty: true,
      status: "ready",
      error: null,
    });
    this.scheduleSave();
  }

  /** Reports a failed move into or out of this scope through the status the composer already shows. */
  public failWith(error: unknown): void {
    this.failedStep = null;
    this.setState({ status: "error", error: failure(error, "Moving the draft failed") });
  }

  /**
   * Runs again the step that failed: a load, a save or a clear. A failed move is run again by ChatDraft, which
   * owns the moves. Each step reports its outcome in the snapshot, so a step that fails again shows again.
   */
  public async retry(): Promise<void> {
    const step = this.failedStep;
    if (step === null) return;
    if (step === "load") {
      await this.load();
      return;
    }
    this.setState({ status: "ready", error: null });
    if (step === "clear") await this.clearAfterAdmission();
    else await this.flush();
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
    const text = composerTextForIntent(intent);
    // The draft's own attachments are the ones sent. A send names them only by id, name and media type, which would
    // replace the full references the composer holds and make the composer reload them.
    const attachments = [...this.snapshot.attachments];
    this.setDraft(text, attachments);
    try {
      await submitPrompt(intent);
      await this.clearAfterAdmission(intent.text);
    } catch (error) {
      await this.recordFailedSend(text, attachments, error);
      throw error;
    }
  }

  public async clearAfterAdmission(sentText?: string): Promise<void> {
    if (this.snapshot.revision === null && !this.snapshot.dirty) return;
    // Text typed while the prompt was being admitted is not part of it: it stays, and autosave stores it.
    if (sentText !== undefined && this.snapshot.text !== sentText) return;
    this.clearTimer();
    if (this.snapshot.revision === null) {
      // Never stored: there is nothing to remove, and the store would answer "not cleared".
      this.setState({
        text: "",
        attachments: [],
        failedSends: [],
        dirty: false,
        conflict: null,
        status: "ready",
        error: null,
      });
      return;
    }
    try {
      const result = await trackWrite(
        this.scope,
        this.store.clear({ scope: this.scope, expectedRevision: this.snapshot.revision }),
      );
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
        this.fail("clear", appError);
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
        this.fail("save", failure(error, "Saving the draft failed"));
      });
    }, AUTOSAVE_MS);
  }

  private async saveCurrent(): Promise<void> {
    // A draft that has not loaded has no revision to save over: it loads first, so its save is not taken for a conflict.
    if (!this.loaded) {
      await this.load().catch(() => undefined);
      if (!this.loaded) return;
    }
    if (!this.snapshot.dirty || this.snapshot.conflict !== null) return;
    const input = draftInput(
      this.snapshot.text,
      this.snapshot.attachments,
      this.snapshot.failedSends,
    );
    this.saving = input;
    this.setState({ status: "saving", error: null });
    try {
      const saved = await trackWrite(
        this.scope,
        this.store.save({
          scope: this.scope,
          draft: input,
          expectedRevision: this.snapshot.revision,
        }),
      );
      // Text typed while the save was in flight is not in it: it stays unsaved, and the autosave stores it.
      const unchanged = sameInput(
        input,
        draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends),
      );
      this.saving = null;
      this.setState({
        scope: saved.scope,
        status: "ready",
        revision: saved.revision,
        dirty: !unchanged,
        conflict: null,
        error: null,
      });
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict") {
        await this.handleConflict("The draft changed in another tab");
      } else {
        const appError = failure(error, "Saving the draft failed");
        this.fail("save", appError);
        throw appError;
      }
    }
  }

  private async recordFailedSend(
    text: string,
    attachments: readonly AttachmentRef[],
    error: unknown,
  ): Promise<void> {
    const failed: FailedSend = {
      attemptedAt: this.now().toISOString(),
      text,
      attachments: [...attachments],
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
      this.fail("save", failure(error, "Saving the draft failed"));
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Restores the text this tab kept when the app stopped. The kept text is the draft, unless the stored draft
   * is another tab's change since it was typed: then both are kept, the stored text first, and saved over the
   * stored revision. A save this tab had in flight that landed is not another change. Text typed while this
   * loaded comes last.
   */
  private restore(held: BufferedDraft, stored: Draft | null): void {
    const storedInput =
      stored === null ? null : draftInput(stored.text, stored.attachments, stored.failedSends);
    const ownSaveLanded =
      storedInput !== null && held.saving !== null && sameInput(held.saving, storedInput);
    const restored =
      storedInput !== null && !ownSaveLanded && stored?.revision !== held.baseRevision
        ? combineDrafts(storedInput, held.input)
        : held.input;
    const typed = this.snapshot.dirty
      ? draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends)
      : null;
    const merged = typed === null ? restored : combineDrafts(restored, typed);
    this.setState({
      status: "ready",
      text: merged.text,
      attachments: merged.attachments,
      failedSends: merged.failedSends,
      revision: stored?.revision ?? null,
      dirty: true,
      conflict: null,
      error: null,
    });
    this.scheduleSave();
  }

  /** Shows a failed step through the status the composer shows, and keeps which step failed for retry. */
  private fail(step: FailedStep, error: AppFailure): void {
    this.failedStep = step;
    this.setState({ status: "error", error });
  }

  private setState(update: Partial<DraftSnapshot>): void {
    if (update.status !== undefined && update.status !== "error") this.failedStep = null;
    const wasDirty = this.snapshot.dirty;
    this.snapshot = { ...this.snapshot, ...update };
    this.mirrorBuffer(wasDirty);
    for (const listener of this.listeners) listener(this.snapshot);
  }

  /** A failed load keeps the text kept in this tab, with any text typed while it loaded after it. */
  private keepUnsavedOnFailure(held: BufferedDraft | null): void {
    if (held === null) {
      this.mirrorBuffer(false);
      return;
    }
    const typed = this.snapshot.dirty
      ? draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends)
      : null;
    this.buffer?.write(this.scope, {
      input: typed === null ? held.input : combineDrafts(held.input, typed),
      baseRevision: held.baseRevision,
      saving: held.saving,
    });
  }

  /** Keeps the text not yet saved in the buffer, and drops it once the scope is clean. */
  private mirrorBuffer(wasDirty: boolean): void {
    if (this.buffer === undefined || this.loading) return;
    if (this.snapshot.dirty) {
      this.buffer.write(this.scope, {
        input: draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends),
        baseRevision: this.snapshot.revision,
        saving: this.saving,
      });
    } else if (wasDirty) {
      this.buffer.clear(this.scope);
    }
  }
}
