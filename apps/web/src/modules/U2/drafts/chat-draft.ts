import type { DraftScope, FolderPath, ThreadId } from "@omp-app/contracts";
import type { PromptIntent } from "../../R0/runtime/runtime";
import {
  DraftController,
  type DraftLifecycleTarget,
  type DraftStoreAdapter,
  type DraftTimer,
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
  readonly threadId: ThreadId;
  readonly lifecycle?: DraftLifecycleTarget;
  readonly timers?: DraftTimer;
}

export class ChatDraft {
  private readonly options: ChatDraftOptions;
  private current: DraftController;
  private phase: Phase = "loading";
  private busy = false;
  private observed: ChatDraftObservation = { loaded: false, hasMessages: false };
  private moves: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  public constructor(options: ChatDraftOptions) {
    this.options = options;
    this.current = this.create({ kind: "thread", threadId: options.threadId });
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
      this.phase = observation.hasMessages || folder === null ? "sent" : "unsent";
      if (this.phase === "unsent" && folder !== null) {
        this.enqueueMove({ kind: "folder", folder });
      }
      return;
    }
    if (this.phase === "unsent" && observation.hasMessages) {
      this.phase = "sent";
      this.enqueueMove({ kind: "thread", threadId: this.options.threadId });
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

  private enqueueMove(scope: DraftScope): void {
    this.moves = this.moves
      .then(() => this.move(scope))
      .catch((error: unknown) => {
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

  /** Loads the target scope, then takes what the previous controller held. Moves never overlap. */
  private async move(scope: DraftScope): Promise<void> {
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
    for (const listener of this.listeners) listener();
  }

  private create(scope: DraftScope): DraftController {
    return new DraftController({
      store: this.options.store,
      scope,
      lifecycle: this.options.lifecycle,
      timers: this.options.timers,
    });
  }
}
