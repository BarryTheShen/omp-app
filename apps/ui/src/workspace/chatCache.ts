import type { AppClient } from "@omp-app/client";
import type { ThreadId } from "@omp-app/contracts";
import type { ChatController } from "../chat/controller";

/** How many chats stay open after their pane moved on. */
export const KEPT_CHATS = 8;

interface Kept {
  readonly client: AppClient;
  readonly controller: ChatController;
}

/** A chat that ended, or whose omp stopped, exited or failed, is opened afresh rather than shown as it was. */
function usable(controller: ChatController): boolean {
  const { phase, process } = controller.store.getSnapshot();
  return phase !== "ended" && process !== "stopped" && process !== "exited" && process !== "error";
}

/**
 * The chats this page keeps open after their pane moved on: the ones left most recently, each with its live events and
 * its transcript, so going back to one shows it at once, as it is now. A kept chat holds no view on the server
 * (`ChatController.park`): another tab may delete it, and the server's idle rule decides how long its omp stays up.
 * Past the limit, the one left longest ago is closed. A pane that opens a chat takes it from here, and its view back; a
 * pane that moves on gives it back.
 */
export class ChatCache {
  readonly #limit: number;
  /** By chat, the one left longest ago first. */
  readonly #kept = new Map<ThreadId, Kept>();
  /** Chats deleted from this page: a pane that lets go of one afterwards closes it instead. */
  readonly #deleted = new Set<ThreadId>();

  constructor(limit = KEPT_CHATS) {
    this.#limit = limit;
  }

  /** The chat's kept controller on this client, the caller's from now on; undefined when none can be used. */
  take(client: AppClient, threadId: ThreadId): ChatController | undefined {
    const kept = this.#kept.get(threadId);
    if (kept === undefined) return undefined;
    this.#kept.delete(threadId);
    if (kept.client === client && usable(kept.controller)) {
      void kept.controller.unpark();
      return kept.controller;
    }
    void kept.controller.dispose();
    return undefined;
  }

  /**
   * A pane let go of its chat. A chat worth coming back to is kept: one with an id and something in it that has not
   * ended, stopped or been deleted. Anything else is closed, and so is the one left longest ago once more are kept than
   * the limit.
   */
  keep(client: AppClient, controller: ChatController): void {
    const id = controller.threadId;
    const empty = controller.store.getSnapshot().entries.length === 0;
    if (id === null || this.#deleted.has(id) || empty || !usable(controller)) {
      void controller.dispose();
      return;
    }
    const before = this.#kept.get(id);
    if (before !== undefined && before.controller !== controller) void before.controller.dispose();
    this.#kept.delete(id);
    this.#kept.set(id, { client, controller });
    void controller.park();
    for (const [oldest, kept] of this.#kept) {
      if (this.#kept.size <= this.#limit) break;
      this.#kept.delete(oldest);
      void kept.controller.dispose();
    }
  }

  /** A chat deleted from this page: closed now if it is kept, and closed when a pane lets go of it later. */
  forget(threadId: ThreadId): void {
    this.#deleted.add(threadId);
    const kept = this.#kept.get(threadId);
    if (kept === undefined) return;
    this.#kept.delete(threadId);
    void kept.controller.dispose();
  }
}

/** The page's one cache of open chats. */
export const chatCache = new ChatCache();
