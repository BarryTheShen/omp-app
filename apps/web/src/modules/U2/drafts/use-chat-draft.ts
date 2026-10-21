import type { FolderPath, ThreadId } from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useDisposeWhenReplaced } from "@/modules/U4/host";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { ChatDraft } from "./chat-draft";
import type { DraftBuffer } from "./draft-buffer";
import type { DraftController, DraftStoreAdapter } from "./drafts";

/** A chat's messages as the draft needs them: whether the chat has any. Its runtime store is one. */
export interface ChatMessagesSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly messageOrder: readonly string[] };
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
  // draft is built again.
  const chat = useMemo(
    () =>
      new ChatDraft({
        store: draftStore,
        folder,
        threadId,
        startsUnsent: startsUnsent && messages.getSnapshot().messageOrder.length === 0,
        lifecycle,
        buffer,
      }),
    [draftStore, folder, threadId, startsUnsent, messages, lifecycle, buffer],
  );
  // The chat is disposed once it is replaced or unmounted; StrictMode's simulated remount keeps it.
  useDisposeWhenReplaced(chat);
  const subscribeToMessages = useCallback(
    (listener: () => void) => messages.subscribe(listener),
    [messages],
  );
  const hasMessages = useSyncExternalStore(
    subscribeToMessages,
    () => messages.getSnapshot().messageOrder.length > 0,
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
  };
}
