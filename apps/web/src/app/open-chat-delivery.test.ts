import type { AppClient } from "@omp-app/client";
import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { SelectedThreadHistoryController } from "@/modules/R1/history/history";
import { deliverWhenChatOpen, type LiveChat } from "./open-chat-delivery";

const BEFORE = ThreadId.parse("chat-before-new-chat");
const NEW = ThreadId.parse("chat-new");

/** The controller reads its ports when it is built; its switch hold and its settle never use the client. */
function history(): SelectedThreadHistoryController {
  const client = { port: () => ({}) } as unknown as AppClient;
  return new SelectedThreadHistoryController({ client, folder: FolderPath.parse("/workspace") });
}

describe("a send held while a New chat opens (#1652)", () => {
  test("when the New chat does not open, the held send is not sent to the chat before it", async () => {
    const chats = history();
    const deliver = vi.fn(async (_text: string) => undefined);
    const live: LiveChat<[string]> = { threadId: BEFORE, deliver };
    const newChat = Promise.withResolvers<"opened" | "not-opened">();
    // The New chat's click takes the switch hold; the send is made while it opens.
    const releaseNewChatHold = chats.holdSwitch();
    const sent = deliverWhenChatOpen(
      {
        whenSettled: () => chats.whenSettled(),
        openThreadId: () => BEFORE,
        liveChat: () => live,
        nextChange: () => new Promise<void>(() => undefined),
        newChatEnd: newChat.promise,
        keptInNewChat: false,
      },
      ["held message"],
    );
    // The New chat fails: its outcome is settled, and its hold is let go, as the app does for a failed New chat.
    newChat.resolve("not-opened");
    releaseNewChatHold();
    await expect(sent).rejects.toBeInstanceOf(AppFailure);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("when the New chat opens, the held send goes to that chat", async () => {
    const chats = history();
    const deliver = vi.fn(async (_text: string) => undefined);
    const live: LiveChat<[string]> = { threadId: NEW, deliver };
    const newChat = Promise.withResolvers<"opened" | "not-opened">();
    let open = BEFORE;
    const releaseNewChatHold = chats.holdSwitch();
    const sent = deliverWhenChatOpen(
      {
        whenSettled: () => chats.whenSettled(),
        openThreadId: () => open,
        liveChat: () => (open === NEW ? live : null),
        nextChange: () => new Promise<void>(() => undefined),
        newChatEnd: newChat.promise,
        keptInNewChat: false,
      },
      ["held message"],
    );
    open = NEW;
    newChat.resolve("opened");
    releaseNewChatHold();
    await sent;
    expect(deliver).toHaveBeenCalledWith("held message");
  });

  test("a refused send typed in a new chat says it is in the message box of a new chat", async () => {
    const chats = history();
    const deliver = vi.fn(async (_text: string) => undefined);
    const live: LiveChat<[string]> = { threadId: BEFORE, deliver };
    const newChat = Promise.withResolvers<"opened" | "not-opened">();
    const releaseNewChatHold = chats.holdSwitch();
    const sent = deliverWhenChatOpen(
      {
        whenSettled: () => chats.whenSettled(),
        openThreadId: () => BEFORE,
        liveChat: () => live,
        nextChange: () => new Promise<void>(() => undefined),
        newChatEnd: newChat.promise,
        keptInNewChat: true,
      },
      ["held message"],
    );
    newChat.resolve("not-opened");
    releaseNewChatHold();
    await expect(sent).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message:
          "This chat did not open, so your message was not sent. It's in the message box of a new chat: press Enter there to send it.",
        retryable: true,
      },
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a refused send typed in a chat says it is still in that chat's message box", async () => {
    const chats = history();
    const deliver = vi.fn(async (_text: string) => undefined);
    const live: LiveChat<[string]> = { threadId: BEFORE, deliver };
    const newChat = Promise.withResolvers<"opened" | "not-opened">();
    const releaseNewChatHold = chats.holdSwitch();
    const sent = deliverWhenChatOpen(
      {
        whenSettled: () => chats.whenSettled(),
        openThreadId: () => BEFORE,
        liveChat: () => live,
        nextChange: () => new Promise<void>(() => undefined),
        newChatEnd: newChat.promise,
        keptInNewChat: false,
      },
      ["held message"],
    );
    newChat.resolve("not-opened");
    releaseNewChatHold();
    await expect(sent).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message:
          "This chat did not open, so your message was not sent. It's still in the message box.",
        retryable: true,
      },
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});
