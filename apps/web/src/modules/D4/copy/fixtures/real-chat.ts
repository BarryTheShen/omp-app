import type { KeyedTranscriptMessage } from "@/modules/U1/copy";
import realChatJson from "./real-chat.json?raw";

/**
 * The real chat D4.2's e2e spec captured from omp 18.6.1 on the fake model: a fenced prompt with a
 * TypeScript block and a bash block, a bash tool call and its result, a follow-up reply, and a bash
 * command the check page ran. The file holds the app's own message records (the store's `key` and
 * `message`), so the reader sees what the app shows. The tests read it through `TranscriptContentReader`.
 */
export function realChatEntries(): readonly KeyedTranscriptMessage[] {
  const entries: readonly KeyedTranscriptMessage[] = JSON.parse(realChatJson);
  return entries;
}
