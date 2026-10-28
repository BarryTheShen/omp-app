import type { AppClient } from "@omp-app/client";
import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SelectedThreadHistoryController } from "@/modules/R1/history/history";
import { deliverWhenChatOpen } from "./open-chat-delivery";
import { useNewChat } from "./use-new-chat";

const FIRST = ThreadId.parse("chat-first-new-chat");
const SECOND = ThreadId.parse("chat-second-new-chat");

/**
 * The app's New chats over the history's real switch hold. Opening a chat puts it on screen, and a message is sent as the
 * chat view sends it: it waits for the New chat it was sent after. The first message's delivery holds until released.
 */
function newChats() {
  const client = { port: () => ({}) } as unknown as AppClient;
  const controller = new SelectedThreadHistoryController({
    client,
    folder: FolderPath.parse("/workspace"),
  });
  const screen: { open: ThreadId | undefined } = { open: undefined };
  const delivered: string[] = [];
  const firstMessageSent = Promise.withResolvers<void>();
  const hook = renderHook(() =>
    useNewChat({
      controller,
      unsentThread: { current: null },
      setNewChat: () => undefined,
      setNewChatFrom: () => undefined,
      setNewChatThreadId: () => undefined,
      setNewlyStartedThread: () => undefined,
      openStartedChat: async (threadId) => {
        screen.open = threadId;
      },
    }),
  );
  const send = (text: string): Promise<void> => {
    const ticket = hook.result.current.newChatTicketNow();
    const sending = deliverWhenChatOpen(
      {
        whenSettled: () => controller.whenSettled(),
        openThreadId: () => screen.open,
        liveChat: () => {
          const threadId = screen.open;
          if (threadId === undefined) return null;
          return {
            threadId,
            deliver: async (body: string) => {
              delivered.push(`${threadId}: ${body}`);
              if (body === "first message") await firstMessageSent.promise;
            },
          };
        },
        nextChange: () => new Promise<void>(() => undefined),
        newChatEnd: ticket?.outcome ?? null,
        keptInNewChat: false,
      },
      [text],
    );
    ticket?.trackSend(sending);
    return sending;
  };
  return { hook, screen, delivered, firstMessageSent, send };
}

describe("a message sent right after a New chat click (issue 2758)", () => {
  test("goes to that New chat, not to the New chat before it whose first message the click waits for", async () => {
    const { hook, delivered, firstMessageSent, send } = newChats();
    // The first New chat opens, with its first message sent while it opened and still being sent.
    act(() => hook.result.current.reportNewChat({ state: "opening" }));
    const first = send("first message");
    await act(() => hook.result.current.openNewChatFromSidebar(FIRST));
    act(() => hook.result.current.reportNewChat({ state: "idle" }));
    // New chat is clicked again: as the sidebar does, the click asks for its chat, then waits for that first message.
    const endClick = hook.result.current.requestNewChat();
    const clickWait = hook.result.current.openingNewChatTicketNow()?.waitForSettled();
    // The person sends a second message at once, while the first chat is still on screen.
    const second = send("second message");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(delivered).toEqual([`${FIRST}: first message`]);
    // The first message is sent: the click's wait ends, and its New chat opens.
    firstMessageSent.resolve();
    await first;
    await expect(clickWait).resolves.toBe(true);
    act(() => hook.result.current.reportNewChat({ state: "opening" }));
    await act(() => hook.result.current.openNewChatFromSidebar(SECOND));
    act(() => hook.result.current.reportNewChat({ state: "idle" }));
    await second;
    expect(delivered).toEqual([`${FIRST}: first message`, `${SECOND}: second message`]);
    endClick();
  });

  test("is not sent to the chat on screen when the click's chat does not open", async () => {
    const { hook, screen, delivered, send } = newChats();
    screen.open = FIRST;
    const endClick = hook.result.current.requestNewChat();
    const sent = send("message");
    // The click ends without opening its chat (the New chat before it did not send its first message).
    endClick();
    await expect(sent).rejects.toBeInstanceOf(AppFailure);
    expect(delivered).toEqual([]);
  });
});
