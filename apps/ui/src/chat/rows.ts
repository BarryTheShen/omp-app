import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import type { ChatNotice, ChatSnapshot } from "./store";

/** A `!` (bash) or `$` (Python) run: the command, what it printed and how it ended; `running` while omp runs it. */
export interface ShellRunView {
  readonly method: "bash" | "python";
  readonly input: string;
  readonly output: string;
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly excludeFromContext: boolean;
  readonly running: boolean;
}

/**
 * One item of the transcript list: an entry collab-web draws, a failed request, the reply being written, running tools,
 * or "thinking…".
 */
export type TranscriptRow =
  | { readonly kind: "entry"; readonly key: string; readonly entry: SessionEntry }
  | {
      readonly kind: "failure";
      readonly key: string;
      readonly error: string;
      /** The chat's last word: nothing was said or started after it, so it can be retried. */
      readonly latest: boolean;
    }
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
  | { readonly kind: "working"; readonly key: string }
  | { readonly kind: "shell"; readonly key: string; readonly run: ShellRunView }
  | { readonly kind: "notice"; readonly key: string; readonly notice: ChatNotice };

/** A `!` or `$` run omp saved in the session (its `bashExecution` and `pythonExecution` messages). */
function savedShellRun(entry: SessionEntry): ShellRunView | null {
  if (entry.type !== "message") return null;
  const message = entry.message as unknown as Record<string, unknown> & { readonly role: string };
  if (message.role !== "bashExecution" && message.role !== "pythonExecution") return null;
  const input = message.role === "bashExecution" ? message.command : message.code;
  return {
    method: message.role === "bashExecution" ? "bash" : "python",
    input: typeof input === "string" ? input : "",
    output: typeof message.output === "string" ? message.output : "",
    exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined,
    cancelled: message.cancelled === true,
    truncated: message.truncated === true,
    excludeFromContext: message.excludeFromContext === true,
    running: false,
  };
}

/** A reply that ended in an error, with what omp said about it. */
function failure(entry: SessionEntry): { readonly error: string; readonly empty: boolean } | null {
  if (entry.type !== "message" || entry.message.role !== "assistant") return null;
  const message = entry.message as AssistantMessage;
  if (message.stopReason !== "error") return null;
  const error = message.errorMessage?.trim();
  return {
    error: error === undefined || error === "" ? "The request failed." : error,
    empty: message.content.length === 0,
  };
}

/** Whether collab-web's `EntryRow` draws anything for the entry: tool results show inside their call's card. */
function drawn(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "message":
      // A failed reply with nothing in it is only its failure row.
      if (failure(entry)?.empty === true) return false;
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
  snapshot: Pick<
    ChatSnapshot,
    | "entries"
    | "stream"
    | "streamDone"
    | "activeTools"
    | "working"
    | "shell"
    | "notices"
    | "hasOlder"
  >,
): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const seen = new Map<string, number>();
  const committedCalls = new Set<string>();
  // The last failure row, while no message has come after it.
  let lastFailure: number | null = null;
  // The model and thinking level a chat starts with are its settings, not changes: drawn from its first message on.
  let started = snapshot.hasOlder;
  for (const entry of snapshot.entries) {
    if (entry.type === "message") started = true;
    if (!started && (entry.type === "model_change" || entry.type === "thinking_level_change"))
      continue;
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const block of entry.message.content)
        if (block.type === "toolCall") committedCalls.add(block.id);
    }
    const failed = failure(entry);
    // A message after a failure, or a reply that went through, means the failure is no longer the last word.
    const role = entry.type === "message" ? entry.message.role : null;
    if (role === "user" || (role === "assistant" && failed === null)) lastFailure = null;
    const base = entryKey(entry);
    const run = savedShellRun(entry);
    if (run !== null) {
      rows.push({ kind: "shell", key: base, run });
      continue;
    }
    if (drawn(entry)) {
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      rows.push({ kind: "entry", key: count === 0 ? base : `${base}#${count}`, entry });
    }
    if (failed !== null) {
      lastFailure = rows.length;
      rows.push({ kind: "failure", key: `${base}:failure`, error: failed.error, latest: false });
    }
  }
  const stream = snapshot.stream;
  if (lastFailure !== null && !snapshot.working && stream === null) {
    const row = rows[lastFailure];
    if (row?.kind === "failure") rows[lastFailure] = { ...row, latest: true };
  }
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
  if (snapshot.shell !== null) {
    rows.push({
      kind: "shell",
      key: "live:shell",
      run: {
        method: snapshot.shell.method,
        input: snapshot.shell.input,
        output: "",
        exitCode: undefined,
        cancelled: false,
        truncated: false,
        excludeFromContext: snapshot.shell.excludeFromContext,
        running: true,
      },
    });
  }
  for (const notice of snapshot.notices)
    rows.push({ kind: "notice", key: `notice:${notice.id}`, notice });
  return rows;
}
