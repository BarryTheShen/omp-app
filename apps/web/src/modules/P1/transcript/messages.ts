import {
  fromThreadMessageLike,
  type MessageStatus,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { OmpWire } from "@omp-app/contracts";
import { convertMessage } from "@/modules/R0/runtime";

const COMPLETE_UNKNOWN: MessageStatus = { type: "complete", reason: "unknown" };

/**
 * omp hides a custom or hook message marked `display: false`: it is for the model alone. R0 applies
 * the same rule to the main transcript (`isHiddenMessage` in R0/runtime/runtime.ts), so a worker's
 * transcript shows the same rows as a chat.
 */
export function isHiddenTranscriptMessage(message: OmpWire.AgentMessage): boolean {
  return (message.role === "custom" || message.role === "hookMessage") && message.display === false;
}

/**
 * Converts omp's raw messages, in order, with R0's one omp-to-assistant-ui converter. `startIndex` is
 * the first message's position in the whole transcript, so a message keeps its id when later pages
 * are appended.
 */
export function toThreadMessages(
  messages: readonly OmpWire.AgentMessage[],
  startIndex: number,
): ThreadMessageLike[] {
  const converted: ThreadMessageLike[] = [];
  for (const [offset, message] of messages.entries()) {
    if (isHiddenTranscriptMessage(message)) continue;
    converted.push(convertMessage(message, startIndex + offset));
  }
  return converted;
}

/**
 * The same messages in assistant-ui's thread format, for the read-only thread that scrolls them. The
 * rows themselves still come from U3's nested composition.
 */
export function toReadonlyThreadMessages(messages: readonly ThreadMessageLike[]): ThreadMessage[] {
  return messages.map((message, index) =>
    fromThreadMessageLike(message, `p1-transcript-${index}`, COMPLETE_UNKNOWN),
  );
}

/**
 * A live worker's last assistant message is still being written, so a call in it with no result is still
 * running. A finished worker's messages stay complete, so a call with no result in them is unrecorded. Only
 * that message's status changes; the messages are the same.
 */
export function withLiveStatus(
  messages: readonly ThreadMessageLike[],
  live: boolean,
): readonly ThreadMessageLike[] {
  if (!live) return messages;
  let last = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") last = index;
  }
  if (last === -1) return messages;
  return messages.map((message, index) =>
    index === last && message.role === "assistant"
      ? { ...message, status: { type: "running" as const } }
      : message,
  );
}
