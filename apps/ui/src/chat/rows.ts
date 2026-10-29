import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import type { ChatSnapshot } from "./store";

/** One item of the transcript list: an entry collab-web draws, the reply being written, running tools, or "thinking…". */
export type TranscriptRow =
  | { readonly kind: "entry"; readonly key: string; readonly entry: SessionEntry }
  | {
      readonly kind: "stream";
      readonly key: string;
      readonly message: AssistantMessage;
      readonly pending: boolean;
    }
  | {
      readonly kind: "tools";
      readonly key: string;
      readonly tools: readonly ActiveTool[];
      readonly first: boolean;
    }
  | { readonly kind: "working"; readonly key: string };

/** Whether collab-web's `EntryRow` draws anything for the entry: tool results show inside their call's card. */
function drawn(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "message":
      return entry.message.role === "user" || entry.message.role === "assistant";
    case "custom_message":
      return entry.customType === "collab-prompt" || entry.display === true;
    case "compaction":
    case "branch_summary":
    case "model_change":
    case "thinking_level_change":
      return true;
    default:
      return false;
  }
}

/**
 * A key that stays the same when a message first shown from the live stream is read back from the file under omp's
 * own entry id: the message's role and time.
 */
function entryKey(entry: SessionEntry): string {
  if (entry.type !== "message") return entry.id;
  const message = entry.message as { readonly role: string; readonly timestamp?: number };
  return message.timestamp === undefined ? entry.id : `m:${message.role}:${message.timestamp}`;
}

/** The results of tool calls, by call id: each card shows its call's result. */
export function toolResults(
  entries: readonly SessionEntry[],
): ReadonlyMap<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      results.set(entry.message.toolCallId, entry.message);
    }
  }
  return results;
}

export function buildRows(
  snapshot: Pick<ChatSnapshot, "entries" | "stream" | "streamDone" | "activeTools" | "working">,
): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const seen = new Map<string, number>();
  const committedCalls = new Set<string>();
  for (const entry of snapshot.entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const block of entry.message.content)
        if (block.type === "toolCall") committedCalls.add(block.id);
    }
    if (!drawn(entry)) continue;
    const base = entryKey(entry);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    rows.push({ kind: "entry", key: count === 0 ? base : `${base}#${count}`, entry });
  }
  const stream = snapshot.stream;
  if (stream !== null) {
    rows.push({
      kind: "stream",
      key: "live:stream",
      message: stream,
      pending: !snapshot.streamDone,
    });
  }
  const tools = [...snapshot.activeTools.values()].filter(
    (tool) =>
      !committedCalls.has(tool.toolCallId) &&
      !(
        stream?.content.some(
          (block) => block.type === "toolCall" && block.id === tool.toolCallId,
        ) ?? false
      ),
  );
  if (tools.length > 0)
    rows.push({ kind: "tools", key: "live:tools", tools, first: stream === null });
  if (snapshot.working && stream === null && snapshot.activeTools.size === 0) {
    rows.push({ kind: "working", key: "live:working" });
  }
  return rows;
}
