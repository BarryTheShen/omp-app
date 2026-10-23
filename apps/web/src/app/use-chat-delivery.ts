import { AppFailure, type ThreadId } from "@omp-app/contracts";
import { useCallback, useRef } from "react";
import { deliverNoteWhenOpen, type NoSwitchNote } from "@/app/rewind/no-switch-notice";
import type { SelectedThreadHistoryController } from "@/modules/R1/history";
import type { PromptIntent } from "@/modules/U2/contract";
import type { NewChatOutcome } from "./new-chat-outcome";
import { deliverWhenChatOpen } from "./open-chat-delivery";
import type { SendAttachments } from "./thread-props";

interface ChatDeliveryInput {
  readonly controller: SelectedThreadHistoryController | null;
}

export function useChatDelivery({ controller }: ChatDeliveryInput) {
  // The chat on screen registers how a send reaches it: the view that shows the open chat (see `deliverToOpenChat`).
  const liveChat = useRef<{
    readonly threadId: ThreadId;
    readonly deliver: (intent: PromptIntent, attachments: SendAttachments) => Promise<void>;
    readonly notice?: (note: NoSwitchNote) => void;
  } | null>(null);
  const liveChatChanged = useRef<Array<() => void>>([]);
  const registerLiveChat = useCallback(
    (
      threadId: ThreadId,
      deliver: (intent: PromptIntent, attachments: SendAttachments) => Promise<void>,
      notice?: (note: NoSwitchNote) => void,
    ): (() => void) => {
      const live = { threadId, deliver, notice };
      liveChat.current = live;
      const waiters = liveChatChanged.current;
      liveChatChanged.current = [];
      for (const wake of waiters) wake();
      return () => {
        if (liveChat.current === live) liveChat.current = null;
      };
    },
    [],
  );
  // A rewind's note goes to the chat the person has open, through the view that shows it, once that chat has opened
  // (see `deliverNoteWhenOpen`). The rewind's result does not wait for the note.
  const deliverNoteToOpenChat = useCallback(
    (note: NoSwitchNote): Promise<void> => {
      if (controller === null) return Promise.resolve();
      return deliverNoteWhenOpen(
        {
          whenSettled: () => controller.whenSettled(),
          openThreadId: () => controller.getSnapshot().threadId,
          view: () => liveChat.current,
          nextView: () =>
            new Promise<void>((wake) => {
              liveChatChanged.current.push(wake);
            }),
        },
        note,
      );
    },
    [controller],
  );
  // A send goes to the chat that is open when it is delivered, through the view that shows it. While a chat is still
  // opening, the send waits until that chat is on screen: it is never written to the chat before it. If the chat did
  // not open, nothing is sent and the text stays in the composer.
  const deliverToOpenChat = useCallback(
    async (
      intent: PromptIntent,
      attachments: SendAttachments,
      newChatEnd: Promise<NewChatOutcome> | null,
      keptInNewChat: boolean,
    ): Promise<void> => {
      if (controller === null) {
        throw new AppFailure({
          code: "unavailable",
          message: "Open a chat to send a message.",
          retryable: false,
        });
      }
      await deliverWhenChatOpen(
        {
          whenSettled: () => controller.whenSettled(),
          openThreadId: () => controller.getSnapshot().threadId,
          liveChat: () => liveChat.current,
          nextChange: () =>
            new Promise<void>((wake) => {
              liveChatChanged.current.push(wake);
            }),
          newChatEnd,
          keptInNewChat,
        },
        [intent, attachments],
      );
    },
    [controller],
  );
  return { registerLiveChat, deliverNoteToOpenChat, deliverToOpenChat };
}
