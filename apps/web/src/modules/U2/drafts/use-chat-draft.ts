import type { FolderPath, ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useDisposeWhenReplaced } from "@/modules/U4/host";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { ChatDraft } from "./chat-draft";
import type { DraftBuffer } from "./draft-buffer";
import type { DraftController, DraftStoreAdapter } from "./drafts";

/** A chat's messages as the draft needs them: whether the chat has any. Its runtime store is one. */
export interface ChatMessagesSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly messageOrder: readonly string[]; readonly hasUserMessage?: boolean };
  /** The user's prompts in the chat, read when a draft moves into it or a reload finds a copy of one of them. */
  userPrompts?(): readonly string[];
}

export interface UseChatDraftOptions {
  readonly draftStore: DraftStoreAdapter;
  readonly folder: FolderPath | null;
  readonly threadId: ThreadId;
  /** True for a chat opened as new: while it has no messages, its text is the folder's new-chat draft from the first keystroke. */
  readonly startsUnsent?: boolean;
  readonly messages: ChatMessagesSource;
  /** False while the chat's history is still loading. */
  readonly loaded: boolean;
  /** Keeps unsaved text in this tab, so it survives the app's server stopping. */
  readonly buffer?: DraftBuffer;
}

export interface UseChatDraftResult {
  /** The controller the composer shows. It changes when the chat's draft moves to another scope. */
  readonly controller: DraftController;
  /**
   * The chat the draft belongs to: the same object while the chat's draft moves between scopes, and another one once
   * the person switches to another chat (the chat's draft is then built again).
   */
  readonly chat: object;
  /** Sends a prompt from the chat's current draft. */
  readonly submit: (
    intent: PromptIntent,
    send: (intent: PromptIntent) => Promise<void>,
  ) => Promise<void>;
  /** Runs again what failed: a move that did not finish, or the composer's own failed load or save. */
  readonly retry: () => void;
  /** Keeps this tab's text, or takes the other tab's, for a draft conflict the composer shows. */
  readonly resolveConflict: (choice: "local" | "remote") => Promise<void>;
  /** The chat shows a message it did not show before: a send in progress was admitted, so its draft clears now. */
  readonly noteSent: () => void;
}

/**
 * The composer's draft for an open chat. The chat keeps its own draft once it has messages; a chat with no
 * prompt yet keeps its text in the folder's new-chat draft (see `ChatDraft`).
 */
export function useChatDraft({
  draftStore,
  folder,
  threadId,
  startsUnsent = false,
  messages,
  loaded,
  buffer,
}: UseChatDraftOptions): UseChatDraftResult {
  const lifecycle = typeof window === "undefined" ? undefined : window;
  // A chat that starts unsent is new only while it has no messages; a chat that already has some keeps its own draft.
  // While a New chat opens over this chat, the caller passes no messages for it, so the messages source changes and the
  // draft is built again. An unsent chat's draft is the folder's, so the chat is not built again when its thread id
  // arrives: building it again would load the folder draft again and blank the composer while it loads. It takes the
  // id with `setThreadId` instead.
  const [staleChat, setStaleChat] = useState(0);
  const draftThreadKey = startsUnsent && folder !== null ? null : threadId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: an unsent chat takes its thread id through `setThreadId`, and `staleChat` builds the chat again when it cannot take the id.
  const chat = useMemo(
    () =>
      new ChatDraft({
        store: draftStore,
        folder,
        threadId,
        startsUnsent: startsUnsent && messages.getSnapshot().messageOrder.length === 0,
        lifecycle,
        buffer,
        userPrompts: () => messages.userPrompts?.() ?? [],
      }),
    [draftStore, folder, draftThreadKey, staleChat, startsUnsent, messages, lifecycle, buffer],
  );
  // The chat is disposed once it is replaced or unmounted; StrictMode's simulated remount keeps it.
  useDisposeWhenReplaced(chat);
  useEffect(() => {
    // A chat whose draft belongs to another thread cannot take this id: it is built again with the id.
    if (!chat.setThreadId(threadId)) setStaleChat((count) => count + 1);
  }, [chat, threadId]);
  const subscribeToMessages = useCallback(
    (listener: () => void) => messages.subscribe(listener),
    [messages],
  );
  const hasMessages = useSyncExternalStore(
    subscribeToMessages,
    () => messages.getSnapshot().hasUserMessage ?? messages.getSnapshot().messageOrder.length > 0,
  );
  useEffect(() => {
    chat.observe({ loaded, hasMessages });
  }, [chat, loaded, hasMessages]);
  const controller = useSyncExternalStore(chat.subscribe, () => chat.controller);
  return {
    controller,
    chat,
    submit: chat.submit,
    retry: chat.retry,
    resolveConflict: chat.resolveConflict,
    noteSent: chat.noteSent,
  };
}
