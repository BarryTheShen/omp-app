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
  readonly messages: ChatMessagesSource;
  /** False while the chat's history is still loading. */
  readonly loaded: boolean;
  /** Keeps unsaved text in this tab, so it survives the app's server stopping. */
  readonly buffer?: DraftBuffer;
}

export interface UseChatDraftResult {
  /** The controller the composer shows. It changes when the chat's draft moves to another scope. */
  readonly controller: DraftController;
  /** Sends a prompt from the chat's current draft. */
  readonly submit: (
    intent: PromptIntent,
    send: (intent: PromptIntent) => Promise<void>,
  ) => Promise<void>;
}

/**
 * The composer's draft for an open chat. The chat keeps its own draft once it has messages; a chat with no
 * prompt yet keeps its text in the folder's new-chat draft (see `ChatDraft`).
 */
export function useChatDraft({
  draftStore,
  folder,
  threadId,
  messages,
  loaded,
  buffer,
}: UseChatDraftOptions): UseChatDraftResult {
  const lifecycle = typeof window === "undefined" ? undefined : window;
  const chat = useMemo(
    () => new ChatDraft({ store: draftStore, folder, threadId, lifecycle, buffer }),
    [draftStore, folder, threadId, lifecycle, buffer],
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
  return { controller, submit: chat.submit };
}
