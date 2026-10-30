import type { SessionFilePath, ThreadId } from "@omp-app/contracts";
import { useSyncExternalStore } from "react";
import type { Attention } from "./attention";

/** A chat the inbox names: its pane's title, and where it lives, to open it again. */
export interface InboxChat {
  readonly threadId: ThreadId;
  readonly sessionFile: SessionFilePath;
  readonly title: string;
}

/** One row: a chat waiting for you, or what its run settled with while you were elsewhere. */
export interface InboxEntry extends InboxChat {
  readonly state: "waiting" | Attention["kind"];
  /** omp's reason, for a turn or an omp that failed; empty otherwise. */
  readonly reason: string;
  /** When it happened (ms since the epoch). */
  readonly at: number;
}

const newestFirst = (entries: Iterable<InboxEntry>): InboxEntry[] =>
  [...entries].sort((a, b) => b.at - a.at);

/**
 * Tern's attention inbox, for the open chats: one row per chat. A chat waiting for you (an approval, a question) shows
 * for as long as it waits. What a run settled with (done, failed, omp gone) is added only while you were elsewhere,
 * replaces the chat's earlier row, and goes when you look at the chat or clear the inbox. Waiting rows come first, then
 * the newest.
 */
export class Inbox {
  readonly #waiting = new Map<ThreadId, InboxEntry>();
  readonly #settled = new Map<ThreadId, InboxEntry>();
  readonly #listeners = new Set<() => void>();
  #entries: readonly InboxEntry[] = [];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): readonly InboxEntry[] => this.#entries;

  /** The chat waits for you, or no longer does. A chat that starts waiting is in a turn: what it settled with before goes. */
  setWaiting(chat: InboxChat, waiting: boolean, at: number = Date.now()): void {
    const known = this.#waiting.get(chat.threadId);
    if (!waiting) {
      if (known === undefined) return;
      this.#waiting.delete(chat.threadId);
    } else {
      if (known?.title === chat.title && known.sessionFile === chat.sessionFile) return;
      this.#waiting.set(chat.threadId, {
        ...chat,
        state: "waiting",
        reason: "",
        at: known?.at ?? at,
      });
      this.#settled.delete(chat.threadId);
    }
    this.#publish();
  }

  /** The chat's run settled with this while you were elsewhere: it replaces the chat's earlier row. */
  add(chat: InboxChat, attention: Attention, at: number = Date.now()): void {
    this.#settled.set(chat.threadId, {
      ...chat,
      state: attention.kind,
      reason: attention.kind === "done" ? "" : attention.reason,
      at,
    });
    this.#publish();
  }

  /** You looked at the chat: what it settled with goes; a chat waiting for you stays until it is answered. */
  seen(threadId: ThreadId | null): void {
    if (threadId === null || !this.#settled.delete(threadId)) return;
    this.#publish();
  }

  /** Every settled row goes; the chats waiting for you stay. */
  clear(): void {
    if (this.#settled.size === 0) return;
    this.#settled.clear();
    this.#publish();
  }

  #publish(): void {
    this.#entries = [
      ...newestFirst(this.#waiting.values()),
      ...newestFirst(this.#settled.values()),
    ];
    for (const listener of [...this.#listeners]) listener();
  }
}

/** This page's inbox: every pane reports to it, and the bell in the sidebar shows it. */
export const inbox = new Inbox();

let open = false;
const openListeners = new Set<() => void>();
const subscribeOpen = (listener: () => void): (() => void) => {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
};

/** Opens or closes the inbox's popover: the bell and the palette share it. */
export function setInboxOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...openListeners]) listener();
}

export function useInboxOpen(): boolean {
  return useSyncExternalStore(subscribeOpen, () => open);
}

export function useInbox(): readonly InboxEntry[] {
  return useSyncExternalStore(inbox.subscribe, inbox.getSnapshot);
}
