import type { ThreadId } from "@omp-app/contracts";

/**
 * The first message this page sent in each chat it started. omp writes a new chat's file only once its first reply is
 * done, so until then the server has no title for the chat: the chat list names it by this message.
 */
const firstPrompts = new Map<ThreadId, string>();

/** Keeps the chat's first message; later ones, and a message of images only, change nothing. */
export function noteFirstPrompt(threadId: ThreadId, text: string): void {
  if (text.trim() === "" || firstPrompts.has(threadId)) return;
  firstPrompts.set(threadId, text);
}

export function firstPromptOf(threadId: ThreadId): string | undefined {
  return firstPrompts.get(threadId);
}
