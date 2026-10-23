import { FolderPath, ThreadId } from "@omp-app/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, test } from "vitest";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { ScopedDraftStore } from "./test-support";
import type { ChatMessagesSource } from "./use-chat-draft";
import { useChatDraft } from "./use-chat-draft";

/** A chat's message list the test changes the way the runtime store does, with listeners told. */
function messageList(initial: readonly string[]): ChatMessagesSource & {
  add(message: string): void;
} {
  let order = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return { messageOrder: order };
    },
    add(message) {
      order = [...order, message];
      for (const listener of listeners) listener();
    },
  };
}

const folder = FolderPath.parse("/workspace/app");
const prompt: PromptIntent = { mode: "prompt", text: "hello", delivery: "new" };

describe("useChatDraft", () => {
  test("a new chat shows the folder's new-chat draft, and follows the chat to its own draft once it has a message", async () => {
    const store = new ScopedDraftStore();
    const messages = messageList([]);
    const { result, rerender } = renderHook(
      ({ loaded }: { readonly loaded: boolean }) =>
        useChatDraft({
          draftStore: store,
          folder,
          threadId: ThreadId.parse("chat-h"),
          messages,
          loaded,
        }),
      { initialProps: { loaded: false } },
    );
    expect(result.current.controller.getSnapshot().scope).toEqual({
      kind: "thread",
      threadId: "chat-h",
    });

    rerender({ loaded: true });
    await waitFor(() =>
      expect(result.current.controller.getSnapshot().scope).toEqual({ kind: "folder", folder }),
    );

    act(() => messages.add("first message"));
    await waitFor(() =>
      expect(result.current.controller.getSnapshot().scope).toEqual({
        kind: "thread",
        threadId: "chat-h",
      }),
    );
  });

  test("a New chat keeps its folder draft and its text when its thread id arrives, and its first message moves the draft to that thread", async () => {
    const store = new ScopedDraftStore();
    const messages = messageList([]);
    const { result, rerender } = renderHook(
      ({ threadId }: { readonly threadId: ThreadId }) =>
        useChatDraft({
          draftStore: store,
          folder,
          threadId,
          startsUnsent: true,
          messages,
          loaded: true,
        }),
      { initialProps: { threadId: ThreadId.parse("chat-opening") } },
    );
    await result.current.controller.load();
    act(() => result.current.controller.setDraft("typed while opening", []));
    const controller = result.current.controller;

    rerender({ threadId: ThreadId.parse("chat-opened") });
    expect(result.current.controller).toBe(controller);
    expect(controller.getSnapshot()).toMatchObject({
      scope: { kind: "folder", folder },
      text: "typed while opening",
    });

    act(() => messages.add("first message"));
    await waitFor(() =>
      expect(result.current.controller.getSnapshot()).toMatchObject({
        scope: { kind: "thread", threadId: "chat-opened" },
        text: "typed while opening",
      }),
    );
  });

  test("a saved chat's draft follows the chat when another chat is opened", () => {
    const store = new ScopedDraftStore();
    const messages = messageList(["earlier message"]);
    const { result, rerender } = renderHook(
      ({ threadId }: { readonly threadId: ThreadId }) =>
        useChatDraft({ draftStore: store, folder, threadId, messages, loaded: true }),
      { initialProps: { threadId: ThreadId.parse("chat-one") } },
    );
    expect(result.current.controller.getSnapshot().scope).toEqual({
      kind: "thread",
      threadId: "chat-one",
    });
    rerender({ threadId: ThreadId.parse("chat-two") });
    expect(result.current.controller.getSnapshot().scope).toEqual({
      kind: "thread",
      threadId: "chat-two",
    });
  });

  test("a prompt sent from a new chat is sent through the new-chat draft, and the chat is its own afterwards", async () => {
    const store = new ScopedDraftStore();
    const messages = messageList([]);
    const { result } = renderHook(() =>
      useChatDraft({
        draftStore: store,
        folder,
        threadId: ThreadId.parse("chat-i"),
        messages,
        loaded: true,
      }),
    );
    await waitFor(() =>
      expect(result.current.controller.getSnapshot().scope).toEqual({ kind: "folder", folder }),
    );

    await act(async () => {
      await result.current.submit(prompt, async () => {
        messages.add("hello");
      });
    });

    await waitFor(() =>
      expect(result.current.controller.getSnapshot().scope).toEqual({
        kind: "thread",
        threadId: "chat-i",
      }),
    );
  });

  test("a new chat still moves to the folder draft under StrictMode, which runs each effect's cleanup and setup again", async () => {
    const store = new ScopedDraftStore();
    const messages = messageList([]);
    const { result } = renderHook(
      () =>
        useChatDraft({
          draftStore: store,
          folder,
          threadId: ThreadId.parse("chat-s"),
          messages,
          loaded: true,
        }),
      { wrapper: StrictMode },
    );
    await waitFor(() =>
      expect(result.current.controller.getSnapshot().scope).toEqual({ kind: "folder", folder }),
    );
  });

  test("the text typed in a new chat is there in the next new chat after switching chats", async () => {
    const store = new ScopedDraftStore();
    const messages = messageList([]);
    const { result, rerender } = renderHook(
      ({ threadId }: { readonly threadId: string }) =>
        useChatDraft({
          draftStore: store,
          folder,
          threadId: ThreadId.parse(threadId),
          messages,
          loaded: true,
        }),
      { initialProps: { threadId: "chat-q" } },
    );
    await waitFor(() =>
      expect(result.current.controller.getSnapshot().scope).toEqual({ kind: "folder", folder }),
    );
    act(() => result.current.controller.setDraft("unsent in chat q", []));

    // Switching chats: the composer disposes the controller it holds, which saves its text first.
    await result.current.controller.dispose();
    rerender({ threadId: "chat-r" });

    await waitFor(() =>
      expect(result.current.controller.getSnapshot()).toMatchObject({
        scope: { kind: "folder", folder },
        text: "unsent in chat q",
      }),
    );
  });

  test("a chat that starts unsent but already has messages keeps its own draft", () => {
    const store = new ScopedDraftStore();
    const messages = messageList(["first message"]);
    const { result } = renderHook(() =>
      useChatDraft({
        draftStore: store,
        folder,
        threadId: ThreadId.parse("chat-v"),
        startsUnsent: true,
        messages,
        loaded: true,
      }),
    );
    expect(result.current.controller.getSnapshot().scope).toEqual({
      kind: "thread",
      threadId: ThreadId.parse("chat-v"),
    });
  });

  test("a New chat starting over a chat with messages shows the folder's new-chat draft, and the chat's own draft returns when the New chat settles", () => {
    const store = new ScopedDraftStore();
    const chat = messageList(["first message"]);
    // While a New chat opens, the composer shows no messages of the chat on screen, so that chat's text is the folder's draft.
    const opening = messageList([]);
    const chatScope = { kind: "thread", threadId: ThreadId.parse("chat-w") } as const;
    const { result, rerender } = renderHook(
      ({ messages }: { readonly messages: ChatMessagesSource }) =>
        useChatDraft({
          draftStore: store,
          folder,
          threadId: ThreadId.parse("chat-w"),
          startsUnsent: true,
          messages,
          loaded: true,
        }),
      { initialProps: { messages: chat } },
    );
    expect(result.current.controller.getSnapshot().scope).toEqual(chatScope);

    rerender({ messages: opening });
    expect(result.current.controller.getSnapshot().scope).toEqual({ kind: "folder", folder });

    rerender({ messages: chat });
    expect(result.current.controller.getSnapshot().scope).toEqual(chatScope);
  });
});
