/** How a New chat ends: its chat opens, or it ends without one (it failed, or a pick ended it before it opened). */
export type NewChatOutcome = "opened" | "not-opened";

/** One New chat's outcome, open and first send: a later New chat waits for both before replacing it. */
export interface NewChatTicket {
  readonly outcome: Promise<NewChatOutcome>;
  settle(outcome: NewChatOutcome): void;
  trackOpen(open: Promise<void>): void;
  trackSend(send: Promise<void>): void;
  waitForSettled(): Promise<boolean>;
}

export function openNewChatTicket(): NewChatTicket {
  const { promise, resolve } = Promise.withResolvers<NewChatOutcome>();
  let trackedOpen: Promise<void> | null = null;
  let trackedSend: Promise<void> | null = null;
  return {
    outcome: promise,
    settle: resolve,
    trackOpen(open) {
      trackedOpen = open;
    },
    trackSend(send) {
      trackedSend = send;
    },
    async waitForSettled() {
      const send = trackedSend;
      if (send === null) return true;
      const outcome = await promise;
      const results = await Promise.allSettled([
        ...(trackedOpen === null ? [] : [trackedOpen]),
        send,
      ]);
      return outcome === "opened" && results.every((result) => result.status === "fulfilled");
    },
  };
}
