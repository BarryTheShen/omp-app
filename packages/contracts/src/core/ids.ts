/**
 * Stable ids and parent links.
 *
 * Where omp exposes session entry ids (all citations: omp v18.6.1, paths under
 * `packages/coding-agent/src/`; docs are omp's `docs/rpc.md`):
 * - `get_entries` → `{ entries, leafId }`: every entry carries `id` and `parentId` (null at a root),
 *   in append order; `since` returns the entries strictly after that id (modes/rpc/rpc-compat.ts:14-23).
 * - `get_tree` → `{ tree, leafId }`: nodes `{ entry, children, label? }`, ids at `entry.id` and
 *   `entry.parentId` (session/session-entries.ts:327-333).
 * - `get_branch_messages` → `{ entryId, text }` for user messages only (session/agent-session.ts:11735-11750).
 * - `get_subagent_messages` → `entries` of the subagent's own session file.
 * - Inputs: `branch.entryId`, `fork.entryId`, `get_entries.since`.
 * - Not exposed: `message_start` / `message_update` / `message_end` carry `messageId`, which is
 *   `msg-<n>` counted per omp process and maps to no entry (modes/rpc/rpc-session-events.ts:59-87;
 *   docs/rpc.md:767). `get_messages`, `get_messages_page`, `turn_end` and `agent_end` carry bare
 *   messages without ids.
 *
 * Entry ids are 8 hex characters, unique within one session file (session/session-migrations.ts:4-11,
 * session/session-manager.ts:1909-1915). A fork copies the kept entries, ids included, into a new
 * file (session/session-manager.ts:3695-3735), so an entry id is unique only together with its thread.
 *
 * Keying rule for transcript messages:
 * 1. Persisted: `persistedMessageKey(threadId, entryId)`, from `get_entries` / `get_tree`.
 * 2. Streaming: `provisionalMessageKey(processId, messageId)` from `message_start` on; the process
 *    id is part of the key because `messageId` counters restart with every omp process.
 * 3. Reconciling: omp appends a message's entry after it has emitted that message's `message_end`,
 *    and commits entries in `message_end` order (session/agent-session.ts:3176-3188, 3631-3634,
 *    3692 with 3032-3058). After `message_end` the app reads `get_entries { since: <newest entry id
 *    it has paired> }` and calls `pairEndedMessages`: each ended streaming message, in
 *    `message_end` order, takes the first unpaired returned entry with the same `messageIdentity`.
 *    The identity is the one omp itself keys persisted messages by, `sessionMessagePersistenceKey`
 *    (session/turn-persistence.ts:22-63), plus the custom roles:
 *    - assistant: timestamp, provider, model, responseId (empty when absent) and stopReason;
 *    - toolResult: timestamp, toolCallId and toolName;
 *    - user and developer: timestamp and attribution (empty when absent);
 *    - fileMention: timestamp;
 *    - custom and hookMessage, which omp stores as `custom_message` entries
 *      (session/agent-session.ts:3383-3397): customType and the timestamp as ISO text
 *      (session/session-manager.ts:3446-3465).
 *    The fields are declared in the copied wire types (../omp-wire/rpc-wire.generated.ts:92-146,
 *    173-191, 220-224). omp stores the message object itself (session/session-manager.ts:3241-3253)
 *    and the frame carries that object or a shallow copy with deobfuscated content
 *    (session/agent-session.ts:3641-3648), so the identity fields agree on both sides. Content is
 *    never compared: it differs exactly where omp obfuscates. Order breaks ties, such as two
 *    messages of one role and identity in the same millisecond; omp itself compares content there
 *    (session/turn-persistence.ts:65-90). The message then takes its persisted key; the UI keeps
 *    the row and remembers the provisional key as an alias.
 * 4. A streaming message no entry ever matches keeps its provisional key and is gone after a
 *    reload. The `message_end` path skips classifier refusals, empty error turns, one-run custom
 *    notes, `rewind` tool results, and roles other than user, developer, assistant, toolResult,
 *    fileMention, custom and hookMessage (session/agent-session.ts:3310-3341, 3383-3404). Because
 *    order breaks ties, a skipped message followed by a persisted one with the same identity
 *    would take that one's entry; that needs two messages of one role and identity in the same
 *    millisecond.
 */
import { z } from "zod";
import type { OmpMessage } from "./omp";

/** POSIX `/…` or Windows `C:\…` / `C:/…`. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

/** omp session id: the session header `id` and `get_state().sessionId` (a UUIDv7 for new sessions). */
export const ThreadId = z.string().min(1).brand<"ThreadId">();
export type ThreadId = z.infer<typeof ThreadId>;

/** omp session entry id; see the rules above. */
export const EntryId = z.string().min(1).brand<"EntryId">();
export type EntryId = z.infer<typeof EntryId>;

/** The path without the separators that end it. A root keeps its separator: `/` and `C:\` stay whole. */
function withoutTrailingSeparator(path: string): string {
  const root = /^[A-Za-z]:/.test(path) ? 3 : 1;
  let end = path.length;
  while (end > root && /[\\/]/.test(path.charAt(end - 1))) end -= 1;
  return path.slice(0, end);
}

/**
 * Absolute folder whose sessions a per-folder catalog lists (the session header `cwd`). A trailing separator is dropped
 * (`/live/x/` is `/live/x`); a root keeps its separator (`/`, `C:\`).
 */
export const FolderPath = z
  .string()
  .regex(ABSOLUTE_PATH, "expected an absolute path")
  .transform(withoutTrailingSeparator)
  .brand<"FolderPath">();
export type FolderPath = z.infer<typeof FolderPath>;

/** Absolute path of one omp session file. */
export const SessionFilePath = z
  .string()
  .regex(ABSOLUTE_PATH, "expected an absolute path")
  .endsWith(".jsonl")
  .brand<"SessionFilePath">();
export type SessionFilePath = z.infer<typeof SessionFilePath>;

/** The app's id for one call or subscription on its browser-server wire (envelope.ts). */
export const RequestId = z.string().min(1).max(128).brand<"RequestId">();
export type RequestId = z.infer<typeof RequestId>;

/** Provider tool call id: `ToolCall.id`, and `toolCallId` on tool events and tool results. */
export const ToolCallId = z.string().min(1).brand<"ToolCallId">();
export type ToolCallId = z.infer<typeof ToolCallId>;

/** `get_subagents[].id`, `subagent_lifecycle.payload.id`, `cancel_subagent.subagentId`. */
export const SubagentId = z.string().min(1).brand<"SubagentId">();
export type SubagentId = z.infer<typeof SubagentId>;

/** `extension_ui_request.id`, answered by `extension_ui_response.id`. */
export const UiRequestId = z.string().min(1).brand<"UiRequestId">();
export type UiRequestId = z.infer<typeof UiRequestId>;

/** `host_tool_call.id` or `host_uri_request.id`, answered by the matching result frame. */
export const HostCallId = z.string().min(1).brand<"HostCallId">();
export type HostCallId = z.infer<typeof HostCallId>;

/** The app's id for one running omp process (assigned by A0); scopes `OmpStreamMessageId`. */
export const OmpProcessId = z.string().min(1).brand<"OmpProcessId">();
export type OmpProcessId = z.infer<typeof OmpProcessId>;

/** `messageId` of `message_start` / `message_update` / `message_end`, unique within one process. */
export const OmpStreamMessageId = z.string().min(1).brand<"OmpStreamMessageId">();
export type OmpStreamMessageId = z.infer<typeof OmpStreamMessageId>;

/** A node of omp's session tree: its id and its parent's (null for a root). */
export const EntryRef = z.object({ id: EntryId, parentId: EntryId.nullable() });
export type EntryRef = z.infer<typeof EntryRef>;

/**
 * The part of every omp session entry the app relies on (session/session-entries.ts:69-74). The
 * wire types entries as open records; other fields are kept as they are.
 */
export const SessionEntryHead = z.looseObject({
  type: z.string(),
  id: EntryId,
  parentId: EntryId.nullable(),
  timestamp: z.string(),
});
export type SessionEntryHead = z.infer<typeof SessionEntryHead>;

export type PersistedMessageKey = `entry:${string}:${string}`;
export type ProvisionalMessageKey = `stream:${string}:${string}`;
/** The key of a transcript message in app state (rule above). */
export type MessageKey = PersistedMessageKey | ProvisionalMessageKey;

export function persistedMessageKey(thread: ThreadId, entry: EntryId): PersistedMessageKey {
  return `entry:${thread}:${entry}`;
}

export function provisionalMessageKey(
  process: OmpProcessId,
  message: OmpStreamMessageId,
): ProvisionalMessageKey {
  return `stream:${process}:${message}`;
}

/** The fields of a `message` or `custom_message` entry that pairing reads (rule 3). */
const MessageEntry = z.looseObject({
  type: z.literal("message"),
  id: EntryId,
  message: z.unknown(),
});
const CustomMessageEntry = z.looseObject({
  type: z.literal("custom_message"),
  id: EntryId,
  customType: z.string(),
  timestamp: z.string(),
});

/** Per role, the message fields omp's persistence identity reads (rule 3). */
const IdentityFields = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("assistant"),
    timestamp: z.number(),
    provider: z.string(),
    model: z.string(),
    responseId: z.string().optional(),
    stopReason: z.string(),
  }),
  z.object({
    role: z.literal("toolResult"),
    timestamp: z.number(),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  z.object({ role: z.literal("user"), timestamp: z.number(), attribution: z.string().optional() }),
  z.object({
    role: z.literal("developer"),
    timestamp: z.number(),
    attribution: z.string().optional(),
  }),
  z.object({ role: z.literal("fileMention"), timestamp: z.number() }),
  z.object({ role: z.literal("custom"), timestamp: z.number(), customType: z.string() }),
  z.object({ role: z.literal("hookMessage"), timestamp: z.number(), customType: z.string() }),
]);

/**
 * The identity omp gives a message in its session file (rule 3), comparable between a streamed
 * `OmpMessage` and the message read from its entry. Undefined for a role omp does not persist on
 * `message_end`, or when an identity field is missing.
 */
export function messageIdentity(message: unknown): string | undefined {
  const parsed = IdentityFields.safeParse(message);
  if (!parsed.success) return undefined;
  const fields = parsed.data;
  switch (fields.role) {
    case "assistant":
      return JSON.stringify([
        fields.role,
        fields.timestamp,
        fields.provider,
        fields.model,
        fields.responseId ?? "",
        fields.stopReason,
      ]);
    case "toolResult":
      return JSON.stringify([fields.role, fields.timestamp, fields.toolCallId, fields.toolName]);
    case "user":
    case "developer":
      return JSON.stringify([fields.role, fields.timestamp, fields.attribution ?? ""]);
    case "fileMention":
      return JSON.stringify([fields.role, fields.timestamp]);
    case "custom":
    case "hookMessage": {
      const time = new Date(fields.timestamp);
      if (Number.isNaN(time.getTime())) return undefined;
      return JSON.stringify(["custom_message", fields.customType, time.toISOString()]);
    }
  }
}

function entryIdentity(entry: unknown): { id: EntryId; identity: string } | undefined {
  const message = MessageEntry.safeParse(entry);
  if (message.success) {
    const identity = messageIdentity(message.data.message);
    return identity === undefined ? undefined : { id: message.data.id, identity };
  }
  const custom = CustomMessageEntry.safeParse(entry);
  if (!custom.success) return undefined;
  const { id, customType, timestamp } = custom.data;
  return { id, identity: JSON.stringify(["custom_message", customType, timestamp]) };
}

/**
 * Rule 3: the entry each ended streaming message pairs with. `ended` lists the messages in
 * `message_end` order; `entries` is what `get_entries { since }` returned, in append order. Each
 * message takes the first unpaired entry with its identity; the result holds that entry's id, or
 * undefined where no entry matches (yet).
 */
export function pairEndedMessages(
  ended: readonly OmpMessage[],
  entries: readonly unknown[],
): (EntryId | undefined)[] {
  const unpaired = entries.map(entryIdentity);
  return ended.map((message) => {
    const identity = messageIdentity(message);
    if (identity === undefined) return undefined;
    const index = unpaired.findIndex((entry) => entry?.identity === identity);
    const match = unpaired[index];
    if (match === undefined) return undefined;
    unpaired[index] = undefined;
    return match.id;
  });
}
