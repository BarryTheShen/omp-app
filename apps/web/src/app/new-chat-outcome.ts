/** How a New chat ends: its chat opens, or it ends without one (it failed, or a pick ended it before it opened). */
export type NewChatOutcome = "opened" | "not-opened";

/** One New chat's outcome. It settles once: the first settle wins. */
export interface NewChatTicket {
  readonly outcome: Promise<NewChatOutcome>;
  settle(outcome: NewChatOutcome): void;
}

export function openNewChatTicket(): NewChatTicket {
  const { promise, resolve } = Promise.withResolvers<NewChatOutcome>();
  return { outcome: promise, settle: resolve };
}
