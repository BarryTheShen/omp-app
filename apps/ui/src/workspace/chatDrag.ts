import { SessionFilePath, ThreadId } from "@omp-app/contracts";
import type { ChatTarget } from "../chat/controller";

/** The app's own drag type: a chat from the list, dragged onto the workspace. */
export const CHAT_DRAG_TYPE = "application/x-omp-app-chat";

/** What ends a drag; the pointer's first move after it covers a dragged row that went away before its `dragend`. */
const DRAG_ENDS = ["dragend", "drop", "pointermove", "pointerdown"] as const;

/**
 * Puts a chat on a drag that starts in the list. While it is dragged the page carries `data-chat-drag`, and a pane's
 * insides let the drag through to the pane (styles/dockview.css): its message box and controls would otherwise take
 * it, and their drag events made dockview lose the drop.
 */
export function startChatDrag(dataTransfer: DataTransfer, target: ChatTarget): void {
  dataTransfer.setData(CHAT_DRAG_TYPE, JSON.stringify(target));
  dataTransfer.effectAllowed = "copyMove";
  const root = document.documentElement;
  root.dataset.chatDrag = "";
  const end = (): void => {
    delete root.dataset.chatDrag;
    for (const type of DRAG_ENDS) window.removeEventListener(type, end, true);
  };
  for (const type of DRAG_ENDS) window.addEventListener(type, end, true);
}

/**
 * Whether a drag carries a chat. Until the drop a page sees only the types of what a drag holds, not the data, so this
 * is all the workspace can tell while it is dragged over.
 */
export function carriesChat(event: DragEvent | PointerEvent): boolean {
  return (
    event instanceof DragEvent && (event.dataTransfer?.types.includes(CHAT_DRAG_TYPE) ?? false)
  );
}

/** The chat a drop carries; null for anything else, or for data no list of this app wrote. */
export function droppedChat(event: DragEvent | PointerEvent): ChatTarget | null {
  if (!(event instanceof DragEvent)) return null;
  const text = event.dataTransfer?.getData(CHAT_DRAG_TYPE) ?? "";
  if (text === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const threadId = ThreadId.safeParse(value.threadId);
  if (value.kind !== "existing" || !threadId.success) return null;
  if (value.sessionFile === null)
    return { kind: "existing", threadId: threadId.data, sessionFile: null };
  const sessionFile = SessionFilePath.safeParse(value.sessionFile);
  return sessionFile.success
    ? { kind: "existing", threadId: threadId.data, sessionFile: sessionFile.data }
    : null;
}
