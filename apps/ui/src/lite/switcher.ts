import type { ThreadId } from "@omp-app/contracts";
import type { ChatTarget } from "../chat/controller";

/** How many chats the switcher offers before a search: the folder's most recent ones. */
const RECENT_CHATS = 12;
/** How many chats a search lists at most, newest first. */
const FOUND_CHATS = 50;

/** A chat the lite view's switcher offers. */
export interface FolderChat {
  readonly id: ThreadId;
  readonly title: string;
  readonly target: ChatTarget;
}

/**
 * The chats the switcher lists from the folder's, newest first: the most recent ones, or, for a search, those whose
 * title has its text, whatever its case (as the full app's chat list searches).
 */
export function switcherChats(chats: readonly FolderChat[], query: string): readonly FolderChat[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return chats.slice(0, RECENT_CHATS);
  return chats.filter((chat) => chat.title.toLowerCase().includes(needle)).slice(0, FOUND_CHATS);
}
