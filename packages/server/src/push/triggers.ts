/**
 * What the app's own notifications say, and when: a chat starts waiting for an answer from you (an approval, a
 * question), or a chat's turn ends, while no page shows that chat. A page that shows it tells the person itself; a
 * short wait first lets a page that is just coming back (a phone unlocked) take the chat over, and nothing is pushed
 * then. One notification per chat at a time: a newer one replaces it on the device (its tag).
 */
import type { ThreadId } from "@omp-app/contracts";
import type { PushMessage } from "./service";

export interface PushTriggerOptions {
  readonly send: (message: PushMessage) => Promise<unknown>;
  /** The chats this server runs. */
  readonly running: () => readonly { readonly threadId: ThreadId }[];
  readonly waitingFor: (threadId: ThreadId) => boolean;
  readonly onWaitingChange: (listener: () => void) => () => void;
  readonly onTurnEnd: (listener: (threadId: ThreadId) => void) => () => void;
  /** How many pages show the chat now. */
  readonly watchers: (threadId: ThreadId) => number;
  readonly titleOf: (threadId: ThreadId) => Promise<string | null>;
  /** omp's `completion.notify`: a turn's end is told unless it is off. */
  readonly completionOn: () => Promise<boolean>;
  /** How long a page may take to come back before the push goes; 8 seconds by default. */
  readonly graceMs?: number;
  readonly timers?: {
    readonly set: (run: () => void, ms: number) => unknown;
    readonly clear: (handle: unknown) => void;
  };
}

/** Starts telling; returns what stops it. */
export function watchForPush(options: PushTriggerOptions): () => void {
  const grace = options.graceMs ?? 8_000;
  const set = options.timers?.set ?? ((run, ms) => setTimeout(run, ms));
  const clear =
    options.timers?.clear ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<string, unknown>();
  let waitingBefore = new Set<ThreadId>();

  const later = (key: string, threadId: ThreadId, still: () => boolean, body: string): void => {
    if (pending.has(key)) return;
    pending.set(
      key,
      set(() => {
        pending.delete(key);
        if (!still() || options.watchers(threadId) > 0) return;
        void options
          .titleOf(threadId)
          .catch(() => null)
          .then((title) =>
            options.send({
              title: title === null || title === "" ? "A chat" : title,
              body,
              chat: threadId,
              tag: `chat-${threadId}`,
            }),
          )
          .catch(() => undefined);
      }, grace),
    );
  };

  const stopWaiting = options.onWaitingChange(() => {
    const now = new Set(
      options
        .running()
        .map((each) => each.threadId)
        .filter((threadId) => options.waitingFor(threadId)),
    );
    for (const threadId of now) {
      if (!waitingBefore.has(threadId)) {
        later(
          `waiting ${threadId}`,
          threadId,
          () => options.waitingFor(threadId),
          "Waiting for you",
        );
      }
    }
    waitingBefore = now;
  });
  const stopTurns = options.onTurnEnd((threadId) => {
    void options
      .completionOn()
      .catch(() => true)
      .then((on) => {
        // A turn that ended into a question is told as waiting, once.
        if (on && !options.waitingFor(threadId))
          later(`done ${threadId}`, threadId, () => true, "Complete");
      });
  });
  return () => {
    stopWaiting();
    stopTurns();
    for (const handle of pending.values()) clear(handle);
    pending.clear();
  };
}
