import { AppFailure, type ThreadId } from "@omp-app/contracts";
import type { NewChatOutcome } from "./new-chat-outcome";

/** The chat view on screen, as it registered itself to take sends. */
export interface LiveChat<Args extends readonly unknown[]> {
  readonly threadId: ThreadId;
  readonly deliver: (...args: Args) => Promise<void>;
}

export interface OpenChatDeliveryOptions<Args extends readonly unknown[]> {
  /** Resolves once the chat history's current open has settled; a New chat's switch hold keeps it unsettled. */
  readonly whenSettled: () => Promise<void>;
  /** The chat the history has open, or undefined when none is open. */
  readonly openThreadId: () => ThreadId | undefined;
  /** The chat view on screen, or null while it has not registered (or has gone). */
  readonly liveChat: () => LiveChat<Args> | null;
  /** Resolves at the next change of the chat on screen. */
  readonly nextChange: () => Promise<void>;
  /** How the New chat that was opening when the send was made ends: a send is not sent when it does not open. */
  readonly newChatEnd?: Promise<NewChatOutcome> | null;
}

const DID_NOT_OPEN = "The chat did not open, so the message was not sent. Try again.";

/**
 * Delivers a send to the chat that is open when it is delivered, through the view that shows it. While a chat is still
 * opening, the send waits until that chat is on screen. If no chat opens, or the New chat the send waited for ends
 * without opening, it throws, and nothing is sent.
 */
export async function deliverWhenChatOpen<Args extends readonly unknown[]>(
  options: OpenChatDeliveryOptions<Args>,
  args: Args,
): Promise<void> {
  if (options.newChatEnd && (await options.newChatEnd) === "not-opened") {
    throw new AppFailure({ code: "unavailable", message: DID_NOT_OPEN, retryable: true });
  }
  for (;;) {
    await options.whenSettled();
    const open = options.openThreadId();
    if (open === undefined) {
      throw new AppFailure({ code: "unavailable", message: DID_NOT_OPEN, retryable: true });
    }
    const live = options.liveChat();
    if (live !== null && live.threadId === open) return live.deliver(...args);
    await options.nextChange();
  }
}
