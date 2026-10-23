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

/**
 * Whether a New chat click reuses the start of the New chat before it: that New chat is still opening and still on
 * screen, and no message has been sent to it. Then the click is that New chat again, and nothing new starts. A message
 * sent to it keeps its chat, so a later click starts another New chat (issue 2343). A chat picked since then has
 * replaced it on screen, so a click starts one.
 */
export function reusesOpeningNewChat(
  earlier: { readonly ended: boolean; readonly sent: boolean; readonly shown: boolean } | undefined,
): boolean {
  return earlier?.shown === true && !earlier.ended && !earlier.sent;
}
