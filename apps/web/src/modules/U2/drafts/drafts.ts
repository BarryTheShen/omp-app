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

const AUTOSAVE_MS = 1_000;
const MAX_AUTOSAVE_MS = 5_000;

const MOVE_CONFLICT = "The draft changed in another tab before it could move";
type FailedStep = "load" | "save" | "clear";

/**
 * Writes and sends this app is still making, by scope. A controller that loads a scope waits for them first, so a
 * draft flushed as the person leaves a chat, or a send still being admitted, is the one the next chat that opens the
 * same scope reads.
 */
const pendingWrites = new Map<string, Promise<void>>();

function trackWrite<T>(scope: DraftScope, write: Promise<T>): Promise<T> {
  const key = draftScopeStream(scope);
  // Each write waits for the writes already in flight for its scope, so a load that waits for the scope waits for all of
  // them: a send still being admitted, and a save that started after it. Keeping only the latest would let a later save
  // hide the send, and a load would read the buffer copy of that send before the send clears it.
  const earlier = pendingWrites.get(key) ?? Promise.resolve();
  const settled = Promise.all([
    earlier,
    write.then(
      () => undefined,
      () => undefined,
    ),
  ]).then(() => undefined);
  pendingWrites.set(key, settled);
  void settled.then(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
  return write;
}

/** The clears of admitted sends in flight, by scope: a read waits for them after the write chain (see `settledWrites`). */
const pendingClears = new Map<string, Promise<void>>();

/** Registers an admitted send's clear: a read of the scope that begins later waits for it (see `settledWrites`). */
function trackClear(scope: DraftScope, clear: Promise<void>): void {
  const key = draftScopeStream(scope);
  const earlier = pendingClears.get(key) ?? Promise.resolve();
  const settled = Promise.all([
    earlier,
    clear.then(
      () => undefined,
      () => undefined,
    ),
  ]).then(() => undefined);
  pendingClears.set(key, settled);
  void settled.then(() => {
    if (pendingClears.get(key) === settled) pendingClears.delete(key);
  });
}

async function settledWrites(scope: DraftScope): Promise<void> {
  const key = draftScopeStream(scope);
  // The writes in flight first, then the clears of sends admitted meanwhile. A clear is registered at its send's admission,
  // so a read that began during the admission reaches it here. A loop that also waited for writes started later
  // deadlocked the delayed-clear survival test.
  await pendingWrites.get(key);
  await pendingClears.get(key);
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

export interface DraftLifecycleReader {
  readonly read: () => {
    readonly text: string;
    readonly attachments: readonly AttachmentRef[];
  };
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

/**
 * The stored draft and the copy this tab kept, joined for a restore. One text is one draft: a save can land while its answer
 * never reaches the page, so the stored draft already holds the text the kept copy has, and that text is not doubled.
 */
function joinStoredCopy(stored: DraftInput, kept: DraftInput): DraftInput {
  if (stored.text !== kept.text) return combineDrafts(stored, kept);
  return draftInput(
    kept.text,
    distinctBy([...stored.attachments, ...kept.attachments]),
    distinctBy([...stored.failedSends, ...kept.failedSends]),
  );
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

function sameAttachments(left: readonly AttachmentRef[], right: readonly AttachmentRef[]): boolean {
  if (left.length !== right.length) return false;
  for (const [index, ref] of left.entries()) {
    const other = right[index];
    if (
      other === undefined ||
      ref.id !== other.id ||
      ref.name !== other.name ||
      ref.mediaType !== other.mediaType ||
      ref.sizeBytes !== other.sizeBytes ||
      ref.uri !== other.uri
    ) {
      return false;
    }
  }
  return true;
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
  /** The load in progress, if any: a second call while it runs gets the same promise. */
  private loadInFlight: Promise<DraftSnapshot> | undefined;
  /** Whether the draft has loaded: a save loads it first, so the save carries the revision the store holds. */
  private loaded = false;
  /** The text of the save this controller sent and has not heard back about; the buffer keeps it until it lands. */
  private saving: DraftInput | null = null;
  /** What the buffer kept for this scope when the load began: text typed while the load runs is mirrored after it, never over it. */
  private loadingKept: BufferedDraft | null = null;
  private lifecycle: DraftLifecycleTarget | undefined;
  private lifecycleReader: DraftLifecycleReader | undefined;
  private readonly onPageHide = (): void => this.flushLifecycle();
  private readonly onVisibilityChange = (): void => {
    if (this.lifecycle?.document?.visibilityState === "visible") return;
    this.flushLifecycle();
  };
  private scope: DraftScope;
  private snapshot: DraftSnapshot;
  private readonly listeners = new Set<DraftListener>();
  private unsubscribeChanged: (() => void) | undefined;
  private timer: unknown;
  private maxTimer: unknown;
  private flushInFlight: Promise<void> | undefined;
  private saveAttempts = 0;
  private clearAttempts = 0;
  private clearRetry: unknown;
  private readonly selfSavedRevisions = new Set<Revision>();
  private readonly selfClearedRevisions = new Set<Revision>();
  /** The step the error status is for: the composer's Retry runs it again. */
  private failedStep: FailedStep | null = null;
  /** The text of the send in progress, until its admission is known; the chat's own messages can prove it earlier. */
  private sendInFlight: string | null = null;

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
  /** Reads the composer's current text before a pagehide flush, closing the render-to-effect gap. */
  public setLifecycleReader(reader: DraftLifecycleReader | undefined): void {
    this.lifecycleReader = reader;
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
    // What the buffer kept for this scope before anything is typed here. Text typed from now on is mirrored over it,
    // so it is read before the first wait.
    const keptAtStart = holdsText ? null : (this.buffer?.read(this.scope) ?? null);
    this.loadingKept = keptAtStart;
    const replaced =
      this.buffer === undefined ? this.snapshot.replaced : this.buffer.readReplaced(this.scope);
    this.setState({ status: "loading", error: null, replaced });
    let held: BufferedDraft | null = null;
    try {
      await settledWrites(this.scope);
      // Read once the writes in flight have landed: the buffer then holds what the store is about to return. When
      // the person typed while those landed, the buffer holds that text, mirrored over what was kept, so what was
      // kept is the text read at the start.
      held = holdsText
        ? null
        : this.snapshot.dirty
          ? keptAtStart
          : (this.buffer?.read(this.scope) ?? null);
      const result = await this.store.get({ scope: this.scope });
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
      this.keepUnsavedOnFailure(held);
      const appError = failure(error, "Loading the draft failed");
      this.fail("load", appError);
      throw appError;
    } finally {
      this.loadingKept = null;
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
    // Read after the clear: text the person typed while it ran is part of this chat's draft, and it moves with the
    // chat. Read before the clear, that text would be dropped by the reset below and the composer would show the
    // text this move carried over, the held command, instead.
    const held: HeldDraft = {
      text: this.snapshot.text,
      attachments: [...this.snapshot.attachments],
      failedSends: [...this.snapshot.failedSends],
    };
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

  public flush(): Promise<void> {
    if (this.flushInFlight !== undefined) return this.flushInFlight;
    const pending = this.flushNow().finally(() => {
      if (this.flushInFlight === pending) this.flushInFlight = undefined;
    });
    this.flushInFlight = pending;
    return pending;
  }

  private async flushNow(): Promise<void> {
    this.clearTimer();
    if (!this.snapshot.dirty || this.snapshot.conflict !== null) return;
    await this.saveCurrent();
  }

  /**
   * Submit clears the draft only after the injected R0.3 callback resolves at admission. Admission and the clear are a
   * write of this scope, so a controller that loads the scope meanwhile reads the draft after it is cleared. A send that
   * fails is recorded after that write, so the recording does not wait for the send it belongs to.
   */
  public async submit(
    intent: PromptIntent,
    submitPrompt: (intent: PromptIntent) => Promise<void>,
  ): Promise<void> {
    const text = composerTextForIntent(intent);
    // The draft's own attachments are the ones sent. A send names them only by id, name and media type, which would
    // replace the full references the composer holds and make the composer reload them.
    const attachments = [...this.snapshot.attachments];
    this.setDraft(text, attachments);
    this.sendInFlight = text;
    try {
      await trackWrite(this.scope, this.admitAndClear(intent, submitPrompt, text));
    } catch (error) {
      await this.recordFailedSend(text, attachments, error);
      throw error;
    } finally {
      this.sendInFlight = null;
    }
  }

  /**
   * The chat shows the send's own message, so the send was admitted, even when its answer has not reached the page yet:
   * the output of a fast command can come first. The draft clears now, so a reload before the answer cannot bring the
   * sent text back. The answer then finds the draft cleared and does nothing more.
   */
  public noteSent(): void {
    const sent = this.sendInFlight;
    if (sent === null) return;
    this.sendInFlight = null;
    // A failed clear is already the composer's error status (`fail`), which the composer shows with its retry.
    void this.clearAfterAdmissionNow(sent).catch(() => undefined);
  }
  private async admitAndClear(
    intent: PromptIntent,
    submitPrompt: (intent: PromptIntent) => Promise<void>,
    text: string,
  ): Promise<void> {
    await submitPrompt(intent);
    // The send is admitted, so it settles here: the composer's input is busy only until then, not for the clear's server
    // round trips. The clear runs as a write of its own, which later reads of this scope wait for (see `settledWrites`).
    // The draft holds the line with its mode prefix (`!pwd`): compare against that, not the bare command. A failed clear is
    // retried (see `clearServerCopy`); the box stays empty meanwhile.
    trackClear(this.scope, this.clearAfterAdmissionNow(text));
  }

  public async clearAfterAdmission(sentText?: string): Promise<void> {
    if (this.snapshot.revision === null && !this.snapshot.dirty) return;
    if (sentText !== undefined && this.snapshot.text !== sentText) return;
    this.clearTimer();
    await settledWrites(this.scope);
    await this.clearAfterAdmissionNow(sentText);
  }

  private async clearAfterAdmissionNow(sentText?: string): Promise<void> {
    if (this.snapshot.revision === null && !this.snapshot.dirty) return;
    // Text typed while the prompt was being admitted is not part of it: it stays, and autosave stores it.
    if (sentText !== undefined && this.snapshot.text !== sentText) return;
    this.clearTimer();
    if (this.clearRetry !== undefined) {
      this.timers.clearTimeout(this.clearRetry);
      this.clearRetry = undefined;
    }
    const sent = draftInput(
      this.snapshot.text,
      this.snapshot.attachments,
      this.snapshot.failedSends,
    );
    // The prompt is delivered, so the box is empty from now on, and this tab's copy says so. That copy is newer than the
    // server's (which still holds the sent text) until the server clear lands: its `saving` copy marks the server copy as
    // this tab's own, so a reload before the clear lands keeps the box empty, while a server copy another tab changed shows.
    this.buffer?.write(this.scope, {
      input: draftInput("", [], []),
      baseRevision: this.snapshot.revision,
      saving: sent,
    });
    this.setState(
      {
        text: "",
        attachments: [],
        failedSends: [],
        dirty: false,
        conflict: null,
        status: "ready",
        error: null,
      },
      false,
    );
    // The chat's own save of this text can still be in flight (the chat was left while the send was admitted). The clear
    // must name the revision that save gives the draft: read before the save lands, it is null, the clear is skipped, and
    // the saved copy stays in the store for the next load to restore.
    await this.flushInFlight?.catch(() => undefined);
    const expectedRevision = this.snapshot.revision;
    if (expectedRevision === null) {
      if (!this.snapshot.dirty) this.buffer?.clear(this.scope);
      return;
    }
    // The save above has landed, so the server copy is at `expectedRevision`: the sent text's marker is no longer needed, and
    // the local copy holds the box's text as it is now, based on that revision (a reload before the clear lands shows the box).
    this.buffer?.write(this.scope, {
      input: draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends),
      baseRevision: expectedRevision,
      saving: null,
    });
    await this.clearServerCopy(expectedRevision);
  }

  /**
   * Clears the server's copy of an admitted send. A failed clear is retried with backoff, as a failed save is; the status
   * line shows the failure only once it keeps failing. Until the clear lands, the box stays empty (see `clearAfterAdmissionNow`).
   */
  private async clearServerCopy(expectedRevision: Revision): Promise<void> {
    try {
      const result = await trackWrite(
        this.scope,
        this.store.clear({ scope: this.scope, expectedRevision }),
      );
      if (!result.cleared) {
        await this.handleConflict("The draft changed before it could be cleared");
        return;
      }
      this.clearAttempts = 0;
      this.rememberSelfRevision(this.selfClearedRevisions, expectedRevision);
      // Text typed since the clear began is this tab's unsaved text: its buffered copy stays.
      if (!this.snapshot.dirty) this.buffer?.clear(this.scope);
      this.setState({ revision: result.revision, status: "ready", error: null });
    } catch (error) {
      if (isConflictFailure(error)) {
        await this.handleConflict("The draft changed before it could be cleared");
        return;
      }
      this.clearAttempts += 1;
      if (this.clearAttempts >= 2) this.fail("clear", failure(error, "Clearing the draft failed"));
      this.scheduleClearRetry(expectedRevision);
    }
  }

  private scheduleClearRetry(expectedRevision: Revision): void {
    const delay = Math.min(5_000, 250 * 2 ** (this.clearAttempts - 1));
    this.clearRetry = this.timers.setTimeout(() => {
      this.clearRetry = undefined;
      void this.clearServerCopy(expectedRevision);
    }, delay);
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
    if (this.timer === undefined) {
      this.maxTimer = this.timers.setTimeout(() => {
        this.maxTimer = undefined;
        if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
        this.timer = undefined;
        void this.flush().catch((error) => {
          this.fail("save", failure(error, "Saving the draft failed"));
        });
      }, MAX_AUTOSAVE_MS);
    } else {
      this.timers.clearTimeout(this.timer);
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.maxTimer !== undefined) this.timers.clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
      void this.flush().catch((error) => {
        this.fail("save", failure(error, "Saving the draft failed"));
      });
    }, AUTOSAVE_MS);
  }

  private scheduleRetry(): void {
    this.clearTimer();
    const delay = Math.min(5_000, 250 * 2 ** this.saveAttempts++);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, delay);
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
      // Text typed while the save was in flight is not in it. The autosave timers it started may already have fired
      // while this save was still in flight (a second flush joins the one in flight and does nothing), so the save
      // is scheduled again here, or that text would wait for the next keystroke.
      const unchanged = sameInput(
        input,
        draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends),
      );
      this.saveAttempts = 0;
      this.saving = null;
      this.rememberSelfRevision(this.selfSavedRevisions, saved.revision);
      this.setState({
        scope: saved.scope,
        status: "ready",
        revision: saved.revision,
        dirty: !unchanged,
        conflict: null,
        error: null,
      });
      if (!unchanged) this.scheduleSave();
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict") {
        await this.handleSaveConflict();
      } else {
        const appError = failure(error, "Saving the draft failed");
        this.fail("save", appError);
        this.scheduleRetry();
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

  private async handleConflict(
    message: string,
    known?: { readonly draft: Draft | null },
  ): Promise<void> {
    const result = known ?? (await this.store.get({ scope: this.scope }));
    this.setState({
      status: "conflict",
      conflict: {
        local: draftInput(this.snapshot.text, this.snapshot.attachments, this.snapshot.failedSends),
        remote: result.draft,
      },
      error: new AppFailure({ code: "conflict", message, retryable: true }),
    });
  }

  /**
   * A save met a revision it did not expect. When the stored draft holds exactly what is here, an earlier save of this
   * tab was applied and only its answer was lost: the stored revision is adopted and nothing is shown. Otherwise
   * another tab changed the draft, and the person chooses.
   */
  private async handleSaveConflict(): Promise<void> {
    const result = await this.store.get({ scope: this.scope });
    const remote = result.draft;
    const local = draftInput(
      this.snapshot.text,
      this.snapshot.attachments,
      this.snapshot.failedSends,
    );
    if (
      remote !== null &&
      sameInput(local, draftInput(remote.text, remote.attachments, remote.failedSends))
    ) {
      this.saveAttempts = 0;
      this.saving = null;
      this.rememberSelfRevision(this.selfSavedRevisions, remote.revision);
      this.setState({
        status: "ready",
        revision: remote.revision,
        dirty: false,
        conflict: null,
        error: null,
      });
      return;
    }
    await this.handleConflict("The draft changed in another tab", result);
  }

  private rememberSelfRevision(revisions: Set<Revision>, revision: Revision): void {
    if (revisions.size >= 8) revisions.delete(revisions.values().next().value as Revision);
    revisions.add(revision);
  }
  private subscribeToChanges(): void {
    if (!this.store.subscribeChanged) return;
    this.unsubscribeChanged = this.store.subscribeChanged(this.scope, (change) => {
      if (!sameScope(change.scope, this.scope)) return;
      if (
        (change.draft === null &&
          this.snapshot.revision !== null &&
          this.selfClearedRevisions.delete(this.snapshot.revision)) ||
        (change.draft !== null && this.selfSavedRevisions.delete(change.draft.revision))
      )
        return;
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
    const current = this.lifecycleReader?.read();
    if (
      current !== undefined &&
      (current.text !== this.snapshot.text ||
        !sameAttachments(current.attachments, this.snapshot.attachments))
    ) {
      this.setDraft(current.text, current.attachments);
    }
    void this.flush().catch((error) => {
      this.fail("save", failure(error, "Saving the draft failed"));
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.maxTimer !== undefined) {
      this.timers.clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
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
        ? joinStoredCopy(storedInput, held.input)
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

  private setState(update: Partial<DraftSnapshot>, mirror = true): void {
    if (update.status !== undefined && update.status !== "error") this.failedStep = null;
    const wasDirty = this.snapshot.dirty;
    this.snapshot = { ...this.snapshot, ...update };
    if (mirror) this.mirrorBuffer(wasDirty);
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
    const entry: BufferedDraft = {
      input: typed === null ? held.input : combineDrafts(held.input, typed),
      baseRevision: held.baseRevision,
      saving: held.saving,
    };
    this.buffer?.write(this.scope, entry);
  }

  /**
   * Keeps the text not yet saved in the buffer. Text typed while the scope is loading goes after the copy the buffer
   * held when the load began, so a keystroke never replaces it.
   */
  private mirrorBuffer(wasDirty: boolean): void {
    if (this.buffer === undefined) return;
    if (this.snapshot.dirty) {
      const typed = draftInput(
        this.snapshot.text,
        this.snapshot.attachments,
        this.snapshot.failedSends,
      );
      const kept = this.loaded ? null : this.loadingKept;
      this.buffer.write(
        this.scope,
        kept === null
          ? { input: typed, baseRevision: this.snapshot.revision, saving: this.saving }
          : {
              input: combineDrafts(kept.input, typed),
              baseRevision: kept.baseRevision,
              saving: kept.saving,
            },
      );
    } else if (wasDirty) {
      this.buffer.clear(this.scope);
    }
  }
}
