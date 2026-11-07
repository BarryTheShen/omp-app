import { firstPromptTextOf } from "@omp-app/contracts";
import type { ChatController } from "./controller";
import { userText } from "./MessageActions";
import { useSavedTitle } from "./savedTitles";
import type { ChatSnapshot } from "./store";

/** How much of a chat's name a window's tab and the lite view's header show. */
const TITLE_CHARACTERS = 60;

/**
 * A chat's name, as the chat list names it: the name it was saved with once it is saved (omp's name for it, #2829),
 * else its first message (or the files' names, #2830), else "New chat".
 */
export function useChatTitle(controller: ChatController, entries: ChatSnapshot["entries"]): string {
  const first = entries
    .map(userText)
    .map((text) => (text === null ? null : firstPromptTextOf(text)))
    .find((text): text is string => text !== null && text !== "");
  const savedTitle = useSavedTitle(controller.threadId);
  return (savedTitle ?? first ?? "New chat").slice(0, TITLE_CHARACTERS);
}
