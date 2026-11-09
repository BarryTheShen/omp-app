import { ThreadId } from "@omp-app/contracts";

/**
 * The event the desktop window sends its page to show a chat a link named: the lite view's "Open in the desktop app"
 * opens `omp-app://chat/<id>?server=<origin>`, and the window's app runs the page's script for it
 * (`apps/desktop/src-tauri/src/chat_link.rs`). A window that opens for such a link has `#chat=<id>` in its address
 * instead (`workspace/linkChat.ts`).
 */
export const OPEN_CHAT_EVENT = "omp-app:open-chat";

/** Chats asked for before the workspace listened (a link that came while the page was still starting). */
const waiting: ThreadId[] = [];
let consumer: ((threadId: ThreadId) => void) | null = null;

// From the page's first moment, so a chat the window asks for while the page starts is not lost.
window.addEventListener(OPEN_CHAT_EVENT, (event) => {
  const parsed = ThreadId.safeParse((event as CustomEvent<unknown>).detail);
  if (!parsed.success) return;
  if (consumer === null) waiting.push(parsed.data);
  else consumer(parsed.data);
});

/**
 * Calls `open` with each chat the desktop window asks this page to show, the ones asked before first; a detail that is
 * not a chat's id is dropped. One listener at a time: the workspace's.
 */
export function onDesktopOpenChat(open: (threadId: ThreadId) => void): () => void {
  consumer = open;
  for (const threadId of waiting.splice(0)) open(threadId);
  return () => {
    if (consumer === open) consumer = null;
  };
}
