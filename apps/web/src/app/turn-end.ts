import type { RuntimeSnapshot } from "@/modules/R0/store";

/**
 * When the newest message is an assistant answer that has finished (not still streaming, not a step
 * that stops for a tool), its timestamp; otherwise undefined.
 *
 * It tells that a turn is over without reading the prompt flags: a page that attaches just after
 * the turn began never sees them change (it refetches the messages instead), but the answer is
 * there at the end. The timestamp is the same while a message is live and after it is saved.
 */
export function finishedAnswerAt(
  snapshot: Pick<RuntimeSnapshot, "messageOrder" | "messages"> | undefined,
): number | undefined {
  if (snapshot === undefined) return undefined;
  const key = snapshot.messageOrder.at(-1);
  if (key === undefined) return undefined;
  const entry = snapshot.messages[key];
  if (entry === undefined || entry.status === "streaming") return undefined;
  const message = entry.message;
  if (message.role !== "assistant" || message.stopReason === "toolUse") return undefined;
  return message.timestamp;
}
