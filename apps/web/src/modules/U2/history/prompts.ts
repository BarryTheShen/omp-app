import type { Omp } from "@omp-app/contracts";
import type { OmpRuntimeStore, RuntimeSnapshot } from "../../R0/store/store";
import type { PromptHistorySource } from "./history";

/** A prompt's text: the typed string, or the text parts of a block list (images are not prompt text). */
function promptText(content: Omp.MessageContent): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
}

/**
 * The prompts the user sent in one chat, oldest first, read from R0's snapshot: the messages the
 * transcript shows, so there is no second history. Omp's synthetic user messages were not typed by
 * anyone and are left out; a prompt that repeats the one before it is kept once, as omp's history does.
 */
export function userPromptsIn(
  snapshot: Pick<RuntimeSnapshot, "messageOrder" | "messages">,
): readonly string[] {
  const prompts: string[] = [];
  for (const key of snapshot.messageOrder) {
    const message = snapshot.messages[key]?.message;
    if (message?.role !== "user" || message.synthetic === true) continue;
    const text = promptText(message.content);
    if (text.trim() === "" || text === prompts[prompts.length - 1]) continue;
    prompts.push(text);
  }
  return prompts;
}

/**
 * U2.5's prompt source for one chat's R0 store. Prompts are read when they are asked for, so a chat
 * switch or a new prompt is seen at the next arrow key; the store's notifications only refresh.
 */
export function createStorePromptSource(
  store: Pick<OmpRuntimeStore, "getSnapshot" | "subscribe">,
): PromptHistorySource {
  let read: { readonly snapshot: RuntimeSnapshot; readonly prompts: readonly string[] } | null =
    null;
  return {
    getUserPrompts(): readonly string[] {
      const snapshot = store.getSnapshot();
      if (read?.snapshot !== snapshot) read = { snapshot, prompts: userPromptsIn(snapshot) };
      return read.prompts;
    },
    subscribe(listener: () => void): () => void {
      return store.subscribe(() => listener());
    },
  };
}
