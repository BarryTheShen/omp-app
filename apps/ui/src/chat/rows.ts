import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { silentAbort } from "../vendor/collab-web/components/transcript/Transcript";
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
  | { readonly kind: "notice"; readonly key: string; readonly notice: ChatNotice }
  | {
      readonly kind: "toolgroup";
      readonly key: string;
      readonly items: readonly GroupItem[];
      /** omp works on after the group's last call, nothing else showing it: the group's head says so. */
      readonly busy?: true;
    };

/** One thing a group of tool calls holds, in order: a call, the thinking between calls, or a line leading into one. */
export type GroupItem =
  | {
      readonly kind: "call";
      readonly id: string;
      readonly name: string;
      readonly intent?: string;
      readonly args: unknown;
      /** From a reply still being written: the call runs until its result comes. */
      readonly pending: boolean;
    }
  | {
      readonly kind: "thinking";
      readonly key: string;
      readonly text: string;
      readonly redacted: boolean;
    }
  /** A one-line lead-in the model wrote before a call ("Checking the queue:"); the group's title while it is the last. */
  | { readonly kind: "lead"; readonly key: string; readonly text: string };

/** The longest one-line text that reads as leading into the next call. */
const LEAD_IN_MAX = 200;

/** A one-line text ending in a colon, short: what the model says it does next, not an answer or a finding. */
export function isLeadIn(text: string): boolean {
  const line = text.trim();
  return line.length > 0 && line.length < LEAD_IN_MAX && line.endsWith(":") && !line.includes("\n");
}

/**
 * A lead-in as a group's title: plain words. The line keeps its Markdown where it is drawn in the group; the title is
 * one line of text, so `**7.341**` reads 7.341 there, not with its stars. Code marks go, a link keeps its words, and a
 * star or underscore inside a word (`snake_case`, `2*3*4`) stays.
 */
export function leadTitle(text: string): string {
  return text
    .trim()
    .replace(/:$/, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replaceAll("`", "");
}

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
export function drawn(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "message": {
      // A failed reply with nothing in it is only its failure row.
      if (failure(entry)?.empty === true) return false;
      // `custom` is omp's own message kind (a background job's notice), live before the file holds it.
      const role: string = entry.message.role;
      if (role === "custom") return (entry.message as { display?: unknown }).display === true;
      // A reply omp stopped itself before it said anything (a plan's review) has nothing to draw.
      if (role === "assistant") {
        const reply = entry.message as AssistantMessage;
        return reply.content.length > 0 || !silentAbort(reply);
      }
      return role === "user";
    }
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

/**
 * The results of tool calls, by call id: each card shows its call's result, or, for a command its call left running in
 * the background, what the job reported last (`jobs`, #2800), so the card fills and settles with the job.
 */
export function toolResults(
  entries: readonly SessionEntry[],
  jobs: ReadonlyMap<string, unknown> = new Map(),
): ReadonlyMap<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      results.set(entry.message.toolCallId, entry.message);
    }
  }
  for (const [id, frame] of jobs) {
    const result = results.get(id);
    const report = frame as { readonly content?: unknown; readonly details?: unknown };
    if (result === undefined || !Array.isArray(report.content)) continue;
    results.set(id, {
      ...result,
      content: report.content as ToolResultMessage["content"],
      details: report.details,
    });
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
      // A key of each reply's own: the list keeps a key's measured height, and a reply under the key of the one before
      // started at that reply's height (a frame 5,000 px too tall after a long reply, and the view jumping with it).
      key: `live:stream:${stream.timestamp}`,
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
    rows.push({
      kind: "tools",
      key: `live:tools:${tools[0]?.toolCallId ?? ""}`,
      tools,
      first: stream === null,
    });
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

type ReplyBlock = AssistantMessage["content"][number];

/** A piece of the list as grouping sees it: a row it leaves whole, or one block of a reply (or one running tool). */
type Piece =
  | { readonly whole: TranscriptRow }
  | { readonly source: TranscriptRow; readonly index: number; readonly item: GroupItem | null };

/**
 * The item a reply's block is in a group, or null when it breaks one. `settled` says the block is finished: a text still
 * being written ("Results:" may go on to a list) is a lead-in only once a later block follows it.
 */
function blockItem(
  block: ReplyBlock,
  key: string,
  pending: boolean,
  settled: boolean,
): GroupItem | null {
  switch (block.type) {
    case "toolCall":
      return {
        kind: "call",
        id: block.id,
        name: block.name,
        ...(block.intent === undefined ? {} : { intent: block.intent }),
        args: block.arguments,
        pending,
      };
    case "thinking":
      return { kind: "thinking", key, text: block.thinking, redacted: false };
    case "redactedThinking":
      return { kind: "thinking", key, text: "", redacted: true };
    case "text":
      return settled && isLeadIn(block.text)
        ? { kind: "lead", key, text: block.text.trim() }
        : null;
    default:
      return null;
  }
}

/**
 * The reply a row draws, when its blocks may go in a group: a saved reply or the one being written. A reply that
 * failed or was stopped stays whole, as its stop chip speaks for all of it.
 */
function replyOf(
  row: TranscriptRow,
): { readonly message: AssistantMessage; readonly pending: boolean } | null {
  if (row.kind === "stream") return { message: row.message, pending: row.pending };
  if (
    row.kind !== "entry" ||
    row.entry.type !== "message" ||
    row.entry.message.role !== "assistant"
  )
    return null;
  const message = row.entry.message as AssistantMessage;
  return message.stopReason === "error" || message.stopReason === "aborted"
    ? null
    : { message, pending: false };
}

function piecesOf(row: TranscriptRow): Piece[] {
  if (row.kind === "tools")
    return row.tools.map((tool, index) => ({
      source: row,
      index,
      item: {
        kind: "call",
        id: tool.toolCallId,
        name: tool.toolName,
        ...(tool.intent === undefined ? {} : { intent: tool.intent }),
        args: tool.args,
        pending: true,
      },
    }));
  const reply = replyOf(row);
  const pieces: Piece[] = [];
  reply?.message.content.forEach((block, index) => {
    // A blank text block draws nothing; it neither breaks a run nor needs a row.
    if (block.type === "text" && block.text.trim() === "") return;
    pieces.push({
      source: row,
      index,
      item: blockItem(
        block,
        `${row.key}:${index}`,
        reply.pending,
        !reply.pending || index < reply.message.content.length - 1,
      ),
    });
  });
  return pieces.length === 0 ? [{ whole: row }] : pieces;
}

/** Derived replies by their entry and the blocks they keep, so a row redrawn with the same blocks keeps its object. */
const kept = new WeakMap<SessionEntry, Map<string, SessionEntry>>();

function keptEntry(entry: SessionEntry, indices: readonly number[]): SessionEntry {
  const sign = indices.join(",");
  const byEntry = kept.get(entry) ?? new Map<string, SessionEntry>();
  kept.set(entry, byEntry);
  const known = byEntry.get(sign);
  if (known !== undefined) return known;
  const message = (entry as Extract<SessionEntry, { type: "message" }>).message as AssistantMessage;
  const derived = {
    ...entry,
    message: { ...message, content: indices.map((index) => message.content[index]) },
  } as SessionEntry;
  byEntry.set(sign, derived);
  return derived;
}

/** A row drawing only some of its source's blocks (or running tools), under a key of its own past the first. */
function partRow(source: TranscriptRow, indices: readonly number[], key: string): TranscriptRow {
  switch (source.kind) {
    case "tools":
      return {
        ...source,
        key,
        tools: indices.map((index) => source.tools[index]).filter((tool) => tool !== undefined),
      };
    case "stream":
      return {
        ...source,
        key,
        message: {
          ...source.message,
          content: indices.flatMap((index) => source.message.content[index] ?? []),
        },
      };
    case "entry":
      return { ...source, key, entry: keptEntry(source.entry, indices) };
    default:
      return source;
  }
}

/**
 * The transcript with each run of tool calls drawn as one group: two calls or more with no text, message or notice
 * between them (thinking may sit inside). A run can cross replies, the reply being written and the tools running now.
 * A reply's text around a group stays in rows of its own, the first under the reply's key.
 *
 * A group keeps the key it was first drawn under while it grows at either end: calls added as omp works, and older
 * calls in front once older entries load above it. `keys` (call id → group key, kept by the caller across draws)
 * remembers them; a new group takes its first call's id.
 */
export function groupToolRuns(
  rows: readonly TranscriptRow[],
  keys: Map<string, string> = new Map(),
): readonly TranscriptRow[] {
  const pieces = rows.flatMap(piecesOf);
  const itemAt = (at: number): GroupItem | null => {
    const piece = pieces[at];
    return piece === undefined || "whole" in piece ? null : piece.item;
  };
  const grouped = new Set<number>();
  let start = 0;
  for (let at = 0; at <= pieces.length; at++) {
    if (itemAt(at) !== null) continue;
    let calls = 0;
    for (let inRun = start; inRun < at; inRun++) if (itemAt(inRun)?.kind === "call") calls += 1;
    if (calls >= 2) for (let inRun = start; inRun < at; inRun++) grouped.add(inRun);
    start = at + 1;
  }
  if (grouped.size === 0) return rows;

  const split = new Set<TranscriptRow>();
  for (const at of grouped) {
    const piece = pieces[at];
    if (piece !== undefined && "source" in piece) split.add(piece.source);
  }
  const out: TranscriptRow[] = [];
  const partsMade = new Map<TranscriptRow, number>();
  let part: { readonly source: TranscriptRow; readonly indices: number[] } | null = null;
  let group: GroupItem[] = [];
  const flushPart = (): void => {
    if (part === null) return;
    const { source, indices } = part;
    part = null;
    if (!split.has(source)) {
      out.push(source);
      return;
    }
    const made = partsMade.get(source) ?? 0;
    partsMade.set(source, made + 1);
    out.push(partRow(source, indices, made === 0 ? source.key : `${source.key}:p${made}`));
  };
  const used = new Set<string>();
  // The group holds part of a reply still being written (its thinking, a call): omp works in it.
  let live = false;
  /** `last`: nothing comes after the group, so a live one is where omp's work shows. */
  const flushGroup = (last = false): void => {
    if (group.length === 0) return;
    const ids = group.flatMap((item) => (item.kind === "call" ? [item.id] : []));
    const known = ids.map((id) => keys.get(id)).find((key) => key !== undefined && !used.has(key));
    let key = known ?? `group:${ids[0] ?? ""}`;
    // A run split in two (a message now between its calls) leaves the second half a key of its own.
    while (used.has(key)) key = `${key}+`;
    used.add(key);
    for (const id of ids) keys.set(id, key);
    out.push({ kind: "toolgroup", key, items: group, ...(last && live ? { busy: true } : {}) });
    group = [];
    live = false;
  };
  pieces.forEach((piece, at) => {
    if ("whole" in piece) {
      flushPart();
      flushGroup();
      out.push(piece.whole);
      return;
    }
    if (grouped.has(at) && piece.item !== null) {
      flushPart();
      group.push(piece.item);
      if (piece.source.kind === "stream" && piece.source.pending) live = true;
      return;
    }
    flushGroup();
    if (part?.source !== piece.source) {
      flushPart();
      part = { source: piece.source, indices: [] };
    }
    part.indices.push(piece.index);
  });
  flushPart();
  flushGroup(true);
  return out;
}

/**
 * One sign that omp works: a group of tool calls last in the chat, while omp works between its steps, shows it in its
 * own head (the spinner a running call gives it) in place of the "thinking…" row under it. The row stays where
 * nothing else shows work (after your message, after a reply's text).
 */
export function workingInGroup(rows: readonly TranscriptRow[]): readonly TranscriptRow[] {
  const at = rows.findIndex((row) => row.kind === "working");
  const before = at > 0 ? rows[at - 1] : undefined;
  if (before?.kind !== "toolgroup") return rows;
  return [...rows.slice(0, at - 1), { ...before, busy: true }, ...rows.slice(at + 1)];
}
