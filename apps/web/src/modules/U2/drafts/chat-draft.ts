import type { DraftScope, FolderPath, ThreadId } from "@omp-app/contracts";
import type { PromptIntent } from "../../R0/runtime/runtime";
import type { DraftBuffer } from "./draft-buffer";
import {
  DraftController,
  type DraftLifecycleTarget,
  type DraftStoreAdapter,
  type DraftTimer,
  draftScopeStream,
  isConflictFailure,
} from "./drafts";

/**
 * The draft the composer shows for one open chat.
 *
 * A chat with messages keeps its own draft, keyed by its thread. A chat with no prompt yet is a new chat:
 * its text lives in the folder's new-chat draft, so the next new chat in that folder shows it again. The
 * app releases an unsent chat's omp process when the person switches away, so a draft keyed by that chat
 * could never be reached again.
 *
 * The chat's phase is decided once its history has loaded; until then it keeps its own draft, as before.
 * Moves between the two drafts run one at a time. A chat stops being new only after the prompt sent from
 * its draft has been admitted and that draft cleared, so the text sent is never copied into the chat.
 */
type Phase = "loading" | "unsent" | "sent";
/** The reload target is known only after initialization; this marker covers the opening interval. */
export function unsentChatReloadMarker(threadId?: ThreadId): string {
  return threadId === undefined ? "opening" : String(threadId);
}

export interface UnsentChatReloadTarget {
  readonly savedThread: string | null;
  readonly unsentMarker: string | null;
}

/** Changes a saved-chat route into an unsent-chat route, including while the new session is opening. */
export function unsentChatReloadTarget(
  current: UnsentChatReloadTarget,
  threadId?: ThreadId,
): UnsentChatReloadTarget {
  return {
    ...current,
    savedThread: null,
    unsentMarker: unsentChatReloadMarker(threadId),
  };
}
/** A sent observer can update reload state only while its own chat remains the active unsent chat. */
export function isCurrentUnsentChat(
  threadId: ThreadId,
  activeUnsentThreadId: ThreadId | null,
  newlyStartedThreadId: ThreadId | null,
): boolean {
  return threadId === activeUnsentThreadId && threadId === newlyStartedThreadId;
}

export interface ChatDraftObservation {
  /** The chat's history has finished loading. */
  readonly loaded: boolean;
  /** The chat's runtime store holds at least one message. */
  readonly hasMessages: boolean;
}

export interface ChatDraftOptions {
  readonly store: DraftStoreAdapter;
  /** The folder the chat belongs to; null when no folder is open, so no new-chat draft can exist. */
  readonly folder: FolderPath | null;
  /** The thread the chat belongs to. An unsent chat's thread is named when the chat opens (see `setThreadId`). */
  readonly threadId: ThreadId;
  /** True for a chat opened as new: it has no messages yet, so its text is the folder's new-chat draft from the first keystroke. */
  readonly startsUnsent?: boolean;
  readonly lifecycle?: DraftLifecycleTarget;
  readonly timers?: DraftTimer;
  /** Keeps unsaved text in this tab, so it survives the app's server stopping. */
  readonly buffer?: DraftBuffer;
  /** The user's prompts the chat's transcript shows, oldest first. A send this browser made is admitted once its text is the newest of them. */
  readonly userPrompts?: () => readonly string[];
}

export class ChatDraft {
  private readonly options: ChatDraftOptions;
  private threadId: ThreadId;
  private current: DraftController;
  private phase: Phase = "loading";
  private busy = false;
  private observed: ChatDraftObservation = { loaded: false, hasMessages: false };
  private moves: Promise<void> = Promise.resolve();
  private pendingMove: DraftScope | null = null;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  public constructor(options: ChatDraftOptions) {
    this.options = options;
    this.threadId = options.threadId;
    // A chat opened as new has no messages yet: its text belongs to the folder's new-chat draft from the first keystroke.
    if (options.startsUnsent === true && options.folder !== null) {
      this.phase = "unsent";
      this.current = this.create({ kind: "folder", folder: options.folder });
    } else {
      this.current = this.create({ kind: "thread", threadId: this.threadId });
    }
  }

  /** The controller the composer uses now. It changes when the chat's draft moves. */
  public get controller(): DraftController {
    return this.current;
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Feeds in the chat's state. The draft moves when that state shows the chat is new, or has been sent. A send
   * in progress decides nothing: `submit` reads the state again once the send has settled.
   */
  public observe(observation: ChatDraftObservation): void {
    this.observed = observation;
    if (this.disposed || this.busy || !observation.loaded) return;
    if (this.phase === "loading") {
      const folder = this.options.folder;
      // A send this browser made that the transcript does not show yet: the chat is not new, its prompt is on its way. The copy
      // stays where it is until the transcript shows that prompt (see `DraftController.admittedBy`).
      if (!observation.hasMessages && this.pendingSends().length > 0) return;
      this.phase = observation.hasMessages || folder === null ? "sent" : "unsent";
      if (this.phase === "unsent" && folder !== null) {
        this.enqueueMove({ kind: "folder", folder });
      } else {
        this.enqueueAdmitted();
      }
      return;
    }
    if (this.phase === "unsent" && observation.hasMessages) {
      this.phase = "sent";
      this.enqueueAdmitted();
      this.enqueueMove({ kind: "thread", threadId: this.threadId });
    }
  }

  /**
   * Sends the prompt from the controller that holds the chat's draft. A move still in flight is waited for first,
   * because it hands the text to another controller. The chat's phase is read again once the send has settled, so
   * a chat that just became sent moves its draft only after its text was cleared.
   */
  public submit = async (
    intent: PromptIntent,
    send: (intent: PromptIntent) => Promise<void>,
  ): Promise<void> => {
    this.busy = true;
    try {
      await this.settledMoves();
      await this.current.submit(intent, send);
    } finally {
      this.busy = false;
      this.observe(this.observed);
    }
  };

  /** Stops moving the draft. The composer disposes the controller it holds. */
  public dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /**
   * Names the thread the chat has now. An unsent chat's draft is the folder's until its first message, so the chat keeps
   * that draft when its thread arrives, and a draft that moves to the chat's thread goes to the one named here. Returns
   * false when the chat's draft belongs to another thread, so the caller must build the chat again.
   */
  public setThreadId(threadId: ThreadId): boolean {
    if (this.phase === "unsent") {
      this.threadId = threadId;
      return true;
    }
    return threadId === this.threadId;
  }

  /** The chat shows a message it did not show before: a send in progress was admitted (see `DraftController.noteSent`). */
  public noteSent = (): void => {
    if (this.busy) {
      this.current.noteSent();
    } else if (this.pendingSends().length > 0) {
      this.enqueueAdmitted();
    }
  };

  /** Runs again what failed: the move that did not finish, or the composer's own failed load or save. */
  public retry = (): void => {
    if (this.pendingMove !== null) {
      this.enqueueMove(this.pendingMove);
      return;
    }
    void this.current.retry().catch(() => undefined);
  };

  /** Resolves the conflict the composer shows; a move that the conflict stopped runs again from the result. */
  public resolveConflict = async (choice: "local" | "remote"): Promise<void> => {
    await this.current.resolveConflict(choice);
    if (this.pendingMove !== null) this.enqueueMove(this.pendingMove);
  };

  private enqueueMove(scope: DraftScope): void {
    this.pendingMove = scope;
    this.moves = this.moves
      .then(() => this.move(scope))
      .catch((error: unknown) => {
        // A conflict leaves its choices in the draft the composer shows; the move runs again once one is made.
        if (isConflictFailure(error) && this.current.getSnapshot().status === "conflict") return;
        this.current.failWith(error);
      });
  }

  /** Resolves once no move is in flight, including moves queued while it waits. */
  private async settledMoves(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.moves;
      await pending;
    } while (pending !== this.moves);
  }

  /** The sends this browser made that still wait to be admitted, with their scope: the folder's new-chat draft and the chat's own. */
  private pendingSends(): { readonly scope: DraftScope; readonly text: string }[] {
    const buffer = this.options.buffer;
    if (buffer === undefined) return [];
    const scopes: DraftScope[] = [{ kind: "thread", threadId: this.threadId }];
    if (this.options.folder !== null)
      scopes.unshift({ kind: "folder", folder: this.options.folder });
    return scopes.flatMap((scope) => {
      const text = buffer.readSent(scope);
      return text === null ? [] : [{ scope, text }];
    });
  }

  /** Drops the copies of sends the transcript now shows admitted. It runs in the move queue, so no move hands such a copy off. */
  private enqueueAdmitted(): void {
    this.moves = this.moves
      .then(() => this.dropAdmitted())
      .catch((error: unknown) => this.current.failWith(error));
  }

  private async dropAdmitted(): Promise<void> {
    const prompts = this.options.userPrompts?.() ?? [];
    if (this.disposed || prompts.length === 0) return;
    const newest = prompts[prompts.length - 1];
    for (const { scope, text } of this.pendingSends()) {
      // A send the transcript does not show as its newest prompt waits, without a load of its scope.
      if (text === newest) await this.admittedIn(scope, prompts);
    }
  }

  /** Runs `admittedBy` on the controller that holds `scope`: the current one, or one built for the scope and disposed after. */
  private async admittedIn(scope: DraftScope, prompts: readonly string[]): Promise<void> {
    if (draftScopeStream(this.current.getSnapshot().scope) === draftScopeStream(scope)) {
      await this.current.admittedBy(prompts);
      return;
    }
    const controller = this.create(scope);
    try {
      await controller.admittedBy(prompts);
    } finally {
      await controller.dispose();
    }
  }

  /** Loads the target scope, then takes what the previous controller held. Moves never overlap. */
  private async move(scope: DraftScope): Promise<void> {
    if (scope.kind === "thread") {
      await this.moveIntoChat(scope);
      return;
    }
    const previous = this.current;
    const next = this.create(scope);
    try {
      await next.load();
      next.adopt(await previous.handOff());
    } catch (error) {
      next.dispose();
      throw error;
    }
    if (this.disposed) {
      await next.flush();
      next.dispose();
      return;
    }
    this.current = next;
    if (this.pendingMove === scope) this.pendingMove = null;
    for (const listener of this.listeners) listener();
  }

  /**
   * Moves the New-chat draft into a chat. The held text goes into the chat's draft before the composer shows it, so text
   * typed while the chat's saved draft is read comes after it. A read that fails is shown on the chat's draft, which
   * keeps the text: Retry reads it again, so a failed read is not a failed move.
   */
  private async moveIntoChat(scope: DraftScope): Promise<void> {
    const held = await this.current.handOff();
    const next = this.create(scope);
    next.adopt(held);
    if (this.disposed) {
      await next.flush();
      next.dispose();
      return;
    }
    this.current = next;
    this.pendingMove = null;
    for (const listener of this.listeners) listener();
    await next.load().catch(() => undefined);
  }

  private create(scope: DraftScope): DraftController {
    return new DraftController({
      store: this.options.store,
      scope,
      lifecycle: this.options.lifecycle,
      timers: this.options.timers,
      buffer: this.options.buffer,
    });
  }
}
