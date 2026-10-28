import type {
  AnswerHostRequestArgs,
  AppError,
  ChatSessionEvent,
  ChatSessionRequest,
  EntryId,
  MessageKey,
  Omp,
  OmpEvent,
  OmpMessage,
  OmpProcessId,
  OmpStreamMessageId,
  PortCallOptions,
  ProvisionalMessageKey,
  ThreadId,
  ToolCallId,
  UiStateEvent,
} from "@omp-app/contracts";
import {
  AppFailure,
  pairEndedMessages as pairEndedOmpMessages,
  persistedMessageKey,
  provisionalMessageKey,
} from "@omp-app/contracts";
import {
  type HostDialogAnswer,
  type HostDialogRequest,
  type HostRequest,
  type HostToolCall,
  type HostToolUpdateParams,
  type HostUriCall,
  isHostDialogRequest,
  isHostToolCall,
  isHostUriCall,
  type ToolCallAnswer,
  type UriReadAnswer,
  type UriWriteAnswer,
} from "@omp-app/contracts/chat-host";
import { createDraft, type Draft, finishDraft, freeze, original } from "immer";
import {
  type HostCallFrame,
  type HostDialogFrame,
  type StoreEvent,
  type StoreFrame,
  storeEventOf,
} from "./store-events";

type QueueMode = Omp.QueueMode;
type SessionState = Omp.SessionState;
type TodoItem = Omp.TodoItem;
type TodoPhase = Omp.TodoPhase;

/**
 * A mutable Immer draft is never exposed; `commit` finishes it into a frozen snapshot that shares every unchanged branch with
 * the previous one. The message order is not in the draft: it is `OmpRuntimeStore.order`, and a change makes a new array.
 */
type MutableSnapshot = {
  -readonly [Key in Exclude<keyof RuntimeSnapshot, "messageOrder">]: RuntimeSnapshot[Key];
};

/**
 * The lifecycle of a message: `pending` is a plain prompt the person sent, shown until omp's echo of it takes its place
 * (`markPromptSent`); the rest come from omp's event stream.
 */
export type RuntimeMessageStatus = "pending" | "streaming" | "ended" | "persisted";

/** omp's answer to a `!` command, as the store keeps it: the host's `ShellRunResult` without its artifact. */
export interface BashCommandResult {
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

/**
 * A `!` command in this chat's omp, from its `running` event. An ended command keeps its row, with omp's answer, until the
 * transcript entry omp writes for it takes the row's place (`settleEndedCommands`).
 */
export interface BashCommandState {
  /** The sequence number of the command's first event: its row keeps this key from running to ended. */
  readonly seq: number;
  /** When omp's bash started, on the server's clock: the command's own entry is written after it. */
  readonly startedAt: number;
  readonly command: string;
  readonly phase: "running" | "ended";
  /** omp's answer, when the call gave one; absent when the call failed. */
  readonly result?: BashCommandResult;
}

/** A finished live-voice turn: its session, speaker and turn number, and the final text. */
export interface VoiceTurn {
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly turn: number;
  readonly text: string;
}

export interface RuntimeMessage {
  readonly key: MessageKey;
  readonly message: OmpMessage;
  readonly status: RuntimeMessageStatus;
  readonly streamMessageId?: OmpStreamMessageId;
  readonly entryId?: EntryId;
  readonly parentId?: EntryId | null;
  readonly interrupted?: boolean;
  /**
   * The key of the streamed copy this message's entry replaced, or of the pending row an omp echo took the place of. The row
   * keeps that key, so its element is not replaced when history returns the entry (issue 1047). `key` stays the message's
   * store key.
   */
  readonly rowKey?: MessageKey;
}

/**
 * A plain prompt the person sent, whose row is shown until omp's echo of it takes the row's place. The echo must come after
 * `afterSeq`, the last seq the store had when the row was added.
 */
interface PendingPrompt {
  readonly key: ProvisionalMessageKey;
  readonly afterSeq: number;
}

/** What a plain prompt shows while it waits for omp's echo: its text and images, as the runtime sends them to omp. */
interface PendingPromptIntent {
  readonly text: string;
  readonly images?: readonly Omp.ImageContent[] | undefined;
}

/**
 * The id of a message's transcript row: the key of its streamed copy when it has one, because the row keeps that id
 * when the saved entry replaces the copy (issue 1047). It does not change when the message is saved.
 */
export function rowIdOf(record: RuntimeMessage): MessageKey {
  return record.rowKey ?? record.key;
}

export interface TranscriptEntry {
  readonly id: EntryId;
  readonly parentId: EntryId | null;
  readonly type: string;
  readonly timestamp?: string;
  readonly messageKey?: MessageKey;
  readonly raw: unknown;
}

export interface TranscriptState {
  readonly entries: Readonly<Record<EntryId, TranscriptEntry>>;
  readonly order: readonly EntryId[];
  readonly head: EntryId | null;
  /** True when the session file holds entries older than the first one loaded on this branch. */
  readonly hasOlder: boolean;
}

export type ToolCallStatus = "running" | "partial" | "success" | "error" | "cancelled";

export interface ToolCallState {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly args?: unknown;
  readonly intent?: string;
  readonly status: ToolCallStatus;
  /** The latest `tool_execution_update` result; omp sends the output so far, so each one replaces the last. */
  readonly partialResult?: unknown;
  /** The latest `tool_stream_update` projection of the in-flight call (for example a diff preview). */
  readonly streamProjection?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export interface PromptResultState {
  readonly type: "prompt_result";
  readonly agentInvoked: boolean;
  readonly status: Omp.PromptStatus;
  readonly sessionSettled: boolean;
  readonly id?: string;
  readonly error?: Omp.PromptError;
}

/** Prompt completion and session settlement are deliberately separate signals. */
export interface PromptLifecycleState {
  readonly admitted: boolean;
  readonly streaming: boolean;
  /** The person sent a prompt from this chat, from the moment the send starts: before omp's echo reaches the transcript. */
  readonly sent: boolean;
  readonly promptResult: PromptResultState | null;
  readonly sessionSettled: boolean;
  readonly promptResults: readonly PromptResultState[];
}

export interface QueueState {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly steeringMode: QueueMode;
  readonly followUpMode: QueueMode;
  readonly interruptMode: Omp.InterruptMode;
  /** Leading steering messages omp already sent into the reply (omp 18.9 `liveSteered`); 0 before that. */
  readonly liveSteered: number;
}

/** A dialog the chat's host waits on (`ui.*`), as the host sent it, until it is answered or given up. */
export interface PendingDialog {
  readonly request: HostDialogRequest;
  readonly receivedSeq: number;
}

/** A call of one of the app's tools the chat's host waits on (`tool.call`), as the host sent it. */
export interface PendingHostToolRequest {
  readonly request: HostToolCall;
  readonly receivedSeq: number;
}

/** A read or write of one of the app's URI schemes the chat's host waits on (`uri.read`, `uri.write`). */
export interface PendingHostUriRequest {
  readonly request: HostUriCall;
  readonly receivedSeq: number;
}

export interface PendingRequestsState {
  readonly dialogs: Readonly<Record<string, PendingDialog>>;
  readonly hostTools: Readonly<Record<string, PendingHostToolRequest>>;
  readonly hostUris: Readonly<Record<string, PendingHostUriRequest>>;
}

/**
 * A failure the chat's banner shows. `heading` replaces the banner's default line when the failure is not the
 * conversation stopping. `extension` names the extension whose failure this is, and the banner shows it before the
 * reason. `source` names the part of omp that sent an error notice; it is kept, and not shown.
 */
export type ChatFailure = AppError & {
  readonly heading?: string | undefined;
  readonly extension?: string | undefined;
  readonly source?: string | undefined;
};

export interface ProcessState {
  readonly status: "starting" | "ready" | "running" | "stopped" | "exited" | "error";
  readonly error: AppError | null;
  /** When the process started (ms since the epoch), as its frames say. Undefined until a frame has said. */
  readonly startedAt?: number;
}

/** omp's `todo_reminder`: the unfinished tasks when a turn stops, shown as a transcript panel (not todo state). */
export interface TodoReminderState {
  readonly todos: readonly TodoItem[];
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The row the panel follows in the transcript (see `rowIdOf`); null when the transcript was empty. */
  readonly afterMessage: MessageKey | null;
}

/**
 * What omp's `get_state` last said about the session. D1 (model, thinking), P2 and P7 (context,
 * compaction) read it here instead of asking omp again; `revision` counts the answers.
 */
export interface SessionInfoState {
  readonly model: SessionState["model"] | null;
  readonly thinkingLevel: SessionState["thinkingLevel"] | null;
  readonly sessionName: string | null;
  readonly contextUsage: SessionState["contextUsage"] | null;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean | null;
  readonly tokensPerSecond: number | null;
  readonly goal: SessionState["goal"] | null;
  readonly revision: number;
}

export interface RuntimeSnapshot {
  readonly threadId: ThreadId;
  /** `<threadId>:<generation>`; message ids are only unique within one omp process. */
  readonly processId: OmpProcessId;
  readonly processGeneration: number;
  readonly revision: number;
  /** The last contiguous envelope event sequence applied to this snapshot. */
  readonly lastSeq: number;
  /** A sequence gap or rejected resume requires history refetch before more events are applied. */
  readonly needsRefetch: boolean;
  readonly transcript: TranscriptState;
  readonly messages: Readonly<Record<MessageKey, RuntimeMessage>>;
  /** The subset of messages that still have provisional stream keys. */
  readonly streaming: Readonly<Record<ProvisionalMessageKey, RuntimeMessage>>;
  readonly messageOrder: readonly MessageKey[];
  /** Ended messages for which no matching persisted entry has arrived yet. */
  readonly pendingEnded: readonly ProvisionalMessageKey[];
  /** Plain prompts the person sent that omp has not echoed yet, oldest first: each row is in `messages` with status `pending`, drawn after `messageOrder` until it joins it. */
  readonly pendingPrompts: readonly PendingPrompt[];
  readonly tools: Readonly<Record<ToolCallId, ToolCallState>>;
  readonly prompt: PromptLifecycleState;
  readonly queue: QueueState;
  /** The `!` commands in this chat's omp, oldest first: running until they end, then ended until their entries are read. */
  readonly commands: readonly BashCommandState[];
  readonly todoPhases: readonly TodoPhase[];
  /** `todo_reminder` panels in arrival order, newest last, at most 20. */
  readonly todoReminders: readonly TodoReminderState[];
  readonly pending: PendingRequestsState;
  readonly process: ProcessState;
  readonly session: SessionInfoState;
  readonly error: ChatFailure | null;
}

export type RuntimeStoreListener = (snapshot: RuntimeSnapshot) => void;
/**
 * A frame the store hands to feature modules by its type: one of the host's events, or the store's own frame for one of
 * the host's requests (see `store-events.ts`).
 */
export type RuntimeNotificationFrame = StoreFrame;
export type RuntimeNotificationListener = (
  frame: RuntimeNotificationFrame,
  seq: number,
  replayed: boolean,
) => void;
export type RuntimeOmpEventListener = (event: OmpEvent, seq: number, replayed: boolean) => void;

interface OmpEventSubscription {
  readonly types: ReadonlySet<string> | undefined;
  readonly listener: RuntimeOmpEventListener;
}

interface NotificationSubscription {
  readonly types: ReadonlySet<string>;
  readonly listener: RuntimeNotificationListener;
}

/** A presentation frame (see `isPresentationFrame`) that no listener was attached for when it arrived. */
interface UndeliveredFrame {
  readonly type: string;
  readonly frame: RuntimeNotificationFrame;
  readonly seq: number;
  readonly replayed: boolean;
}

/** An omp event that no listener was attached for when it arrived. */
interface UndeliveredEvent {
  readonly event: OmpEvent;
  readonly seq: number;
  readonly replayed: boolean;
}

/** The most undelivered items kept per store: the oldest go first. */
const MAX_UNDELIVERED = 200;

/**
 * The host's UI events that only present state (a notice, a status, a widget or a title). Applying one again is harmless
 * and no answer is owed, so a listener attached later may be given the ones that arrived before it.
 */
const PRESENTATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "ui_notify",
  "ui_status",
  "ui_title",
  "ui_widget",
]);

function isPresentationFrame(frame: Record<string, unknown>): boolean {
  return typeof frame.type === "string" && PRESENTATION_EVENT_TYPES.has(frame.type);
}

function keepUndelivered<T>(queue: T[], item: T): void {
  queue.push(item);
  if (queue.length > MAX_UNDELIVERED) queue.splice(0, queue.length - MAX_UNDELIVERED);
}

/** The A0 methods needed by this store; all other runtime actions belong to later R0 parts. */
export interface OmpRuntimeTransport {
  /** The chat session port's requests (`A0.chatSession.request`). */
  readonly request?: ChatSessionRequest;
  /** Answers one of the host's requests: a dialog, a tool call, a URI read or write (`A0.chatSession.answer`). */
  readonly answer?: (args: AnswerHostRequestArgs, options?: PortCallOptions) => Promise<null>;
  /** Sends a running tool call's progress (the host's `host_tool_update`); answers whether the call still runs. */
  readonly updateHostTool?: (
    args: { readonly threadId: ThreadId; readonly params: HostToolUpdateParams },
    options?: PortCallOptions,
  ) => Promise<{ readonly delivered: boolean }>;
}

export interface OmpRuntimeStoreOptions {
  readonly threadId: ThreadId;
  readonly transport?: OmpRuntimeTransport;
}

const EMPTY_TODOS: readonly TodoPhase[] = Object.freeze([]);
const MAX_PROMPT_RESULTS = 20;
const MAX_TODO_REMINDERS = 20;
const EMPTY_REMINDERS: readonly TodoReminderState[] = Object.freeze([]);
const EMPTY_PROMPT: PromptLifecycleState = Object.freeze({
  admitted: false,
  streaming: false,
  sent: false,
  promptResult: null,
  sessionSettled: false,
  promptResults: Object.freeze([]),
});
const EMPTY_QUEUE: QueueState = Object.freeze({
  steering: Object.freeze([]),
  followUp: Object.freeze([]),
  steeringMode: "all",
  followUpMode: "all",
  interruptMode: "immediate",
  liveSteered: 0,
});
const EMPTY_PENDING: PendingRequestsState = Object.freeze({
  dialogs: Object.freeze({}),
  hostTools: Object.freeze({}),
  hostUris: Object.freeze({}),
});
const EMPTY_PROCESS: ProcessState = Object.freeze({ status: "starting", error: null });
/**
 * Whether a notification frame asks the person for something: a dialog, a host call, or a sign-in page to open
 * (`ui_open_url`). A replayed one is never presented again (see `ingest`).
 */
function isAskingFrame(frame: unknown): boolean {
  if (!isRecord(frame)) return false;
  return frame.type === "host_dialog" || frame.type === "ui_open_url" || frame.type === "host_call";
}

const EMPTY_SESSION: SessionInfoState = Object.freeze({
  model: null,
  thinkingLevel: null,
  sessionName: null,
  contextUsage: null,
  isCompacting: false,
  autoCompactionEnabled: null,
  tokensPerSecond: null,
  goal: null,
  revision: 0,
});
const PROCESS_STATUSES: Record<ProcessState["status"], true> = {
  starting: true,
  ready: true,
  running: true,
  stopped: true,
  exited: true,
  error: true,
};

function processIdForGeneration(threadId: ThreadId, generation: number): OmpProcessId {
  return `${threadId}:${generation}` as OmpProcessId;
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) result[key] = cloneValue(item);
  return result as T;
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item, seen);
  }
  return Object.freeze(value);
}

/**
 * Keyed records that a commit changes without copying them whole. Immer copies and walks every key of a changed record, which
 * cost 12 ms a commit at 27,400 messages. Here the keys live in chunks of `CHUNK_KEYS`: a write copies the one chunk it touches
 * and the list of chunks. A record reads as the plain record it stands for (`record[key]`, `key in record`, `Object.keys`, JSON)
 * and cannot be written: the store changes one with `recordWith` and `recordWithout`, which return the record itself when
 * nothing changed.
 */
const CHUNK_KEYS = 64;

/** Which chunk each key is in. A key keeps its chunk, so every version of one record shares this index. */
interface ChunkIndex {
  readonly chunkOf: Map<string, number>;
  /** The chunk the next new key joins, and how many keys it holds. */
  openChunk: number;
  openKeys: number;
}

/** One version of a chunked record. A version is never changed once built: a write builds the next one. */
class ChunkedRecord<V> {
  private readonly index: ChunkIndex;
  private readonly chunks: readonly (ReadonlyMap<string, V> | undefined)[];

  constructor(index: ChunkIndex, chunks: readonly (ReadonlyMap<string, V> | undefined)[]) {
    this.index = index;
    this.chunks = chunks;
  }

  get(key: string): V | undefined {
    const id = this.index.chunkOf.get(key);
    return id === undefined ? undefined : this.chunks[id]?.get(key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  keys(): string[] {
    const keys: string[] = [];
    for (const chunk of this.chunks) {
      if (chunk !== undefined) for (const key of chunk.keys()) keys.push(key);
    }
    return keys;
  }

  set(key: string, value: V): ChunkedRecord<V> {
    if (this.get(key) === value) return this;
    const id = this.index.chunkOf.get(key) ?? this.takeSlot(key);
    const chunk = new Map<string, V>(this.chunks[id]);
    chunk.set(key, value);
    return this.withChunk(id, chunk);
  }

  /** The table with every entry of `updates` set; the same table when each entry already holds its value. */
  setMany(updates: ReadonlyMap<string, V>): ChunkedRecord<V> {
    const touched = new Map<number, Map<string, V>>();
    for (const [key, value] of updates) {
      if (this.get(key) === value) continue;
      const id = this.index.chunkOf.get(key) ?? this.takeSlot(key);
      let chunk = touched.get(id);
      if (chunk === undefined) {
        chunk = new Map<string, V>(this.chunks[id]);
        touched.set(id, chunk);
      }
      chunk.set(key, value);
    }
    if (touched.size === 0) return this;
    const chunks = this.chunks.slice();
    for (const [id, chunk] of touched) chunks[id] = chunk;
    return new ChunkedRecord(this.index, chunks);
  }

  delete(key: string): ChunkedRecord<V> {
    const id = this.index.chunkOf.get(key);
    const current = id === undefined ? undefined : this.chunks[id];
    if (id === undefined || current === undefined || !current.has(key)) return this;
    const chunk = new Map<string, V>(current);
    chunk.delete(key);
    return this.withChunk(id, chunk);
  }

  /** A new key takes a place in the open chunk; a full chunk is followed by the next one. */
  private takeSlot(key: string): number {
    const index = this.index;
    if (index.openKeys === CHUNK_KEYS) {
      index.openChunk += 1;
      index.openKeys = 0;
    }
    index.chunkOf.set(key, index.openChunk);
    index.openKeys += 1;
    return index.openChunk;
  }

  private withChunk(id: number, chunk: ReadonlyMap<string, V>): ChunkedRecord<V> {
    const chunks = this.chunks.slice();
    chunks[id] = chunk;
    return new ChunkedRecord(this.index, chunks);
  }
}

/** The prototype of every record view. Immer copies only plain objects and arrays, so a commit never copies or walks a view. */
class RecordView {}
const RECORD_VIEW_TARGET = new RecordView();

/** Each view's table, by view: `viewOf` registers every view it makes, and `tableOf` reads the table of a view back. */
const tableByView = new WeakMap<object, ChunkedRecord<unknown>>();

/** The read-only record over one version of a chunked record: `record[key]` reads the table, and nothing can be written. */
function viewOf<K extends string, V>(table: ChunkedRecord<V>): Readonly<Record<K, V>> {
  const view = new Proxy(RECORD_VIEW_TARGET, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const value = table.get(prop);
        if (value !== undefined) return value;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      return (typeof prop === "string" && table.has(prop)) || Reflect.has(target, prop);
    },
    ownKeys: () => table.keys(),
    getOwnPropertyDescriptor(_target, prop) {
      const value = typeof prop === "string" ? table.get(prop) : undefined;
      return value === undefined
        ? undefined
        : { value, writable: false, enumerable: true, configurable: true };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  // Unchecked cast: a view answers `view[key]` for the keys of its table, which is what `Readonly<Record<K, V>>` promises.
  const record = view as unknown as Readonly<Record<K, V>>;
  tableByView.set(record, table);
  return record;
}

/** The table behind a view that `viewOf` made, typed to the values of that view. */
function tableOf<V>(record: object): ChunkedRecord<V> {
  const table = tableByView.get(record);
  if (table === undefined) throw new TypeError("Only a record that the store made can be changed.");
  // Unchecked cast: `viewOf` registers each view with the table of its own values, and `recordWith` reads it back for that type.
  const typed = table as ChunkedRecord<V>;
  return typed;
}

/** `record` with `key` set to `value`; the record it came from is unchanged. The value is frozen, as the draft froze it. */
function recordWith<K extends string, V extends object>(
  record: Readonly<Record<K, V>>,
  key: K,
  value: V,
): Readonly<Record<K, V>> {
  const table = tableOf<V>(record);
  const next = table.set(key, freeze(value, true));
  return next === table ? record : viewOf<K, V>(next);
}

/** `record` with every entry of `updates` set, in one copy; the record it came from is unchanged. */
function recordWithMany<K extends string, V extends object>(
  record: Readonly<Record<K, V>>,
  updates: ReadonlyMap<K, V>,
): Readonly<Record<K, V>> {
  const table = tableOf<V>(record);
  const frozen = new Map<string, V>();
  for (const [key, value] of updates) frozen.set(key, freeze(value, true));
  const next = table.setMany(frozen);
  return next === table ? record : viewOf<K, V>(next);
}

/** `record` without `key`; the record it came from is unchanged, and the same record comes back when `key` is not in it. */
function recordWithout<K extends string, V>(
  record: Readonly<Record<K, V>>,
  key: K,
): Readonly<Record<K, V>> {
  const table = tableOf<V>(record);
  const next = table.delete(key);
  return next === table ? record : viewOf<K, V>(next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asEntryId(value: unknown): EntryId | undefined {
  return asString(value) as EntryId | undefined;
}

function asToolCallId(value: unknown): ToolCallId | undefined {
  return asString(value) as ToolCallId | undefined;
}

function appErrorFromUnknown(error: unknown, fallback = "The omp operation failed"): AppError {
  if (isRecord(error) && isRecord(error.appError)) return cloneValue(error.appError) as AppError;
  if (error instanceof Error && error.name === "AppFailure") {
    const appError = (error as AppFailure).appError;
    return cloneValue(appError);
  }
  return {
    code: "internal",
    message: error instanceof Error && error.message.length > 0 ? error.message : fallback,
    retryable: true,
  };
}

function errorForProcess(status: ProcessState["status"]): AppError {
  return {
    code: status === "exited" ? "omp_exited" : "internal",
    message: status === "exited" ? "The omp process exited" : "The omp process reported an error",
    retryable: true,
  };
}

function errorForUnavailable(method: string): AppError {
  return {
    code: "unavailable",
    message: `${method} is unavailable for this runtime store`,
    retryable: false,
  };
}

function isAssistantMessage(message: OmpMessage): message is Omp.AssistantMessage {
  return message.role === "assistant";
}

/** The part field and part type that a streamed block's `_start` and `_delta` events build, or undefined for other events. */
function streamedBlockOf(type: string): { field: string; partType: string } | undefined {
  switch (type) {
    case "text_start":
    case "text_delta":
      return { field: "text", partType: "text" };
    case "thinking_start":
    case "thinking_delta":
      return { field: "thinking", partType: "thinking" };
    case "toolcall_start":
    case "toolcall_delta":
      return { field: "rawBlock", partType: "toolCall" };
    default:
      return undefined;
  }
}

/**
 * The assistant message after one streamed update. A block's text (a tool call's raw text) is built from the deltas the
 * store receives, and a block's start empties it. omp's snapshot can run ahead of its delta, because updates can reach
 * the store together, each carrying the message as it stood when its batch was sent: taking the snapshot's text would
 * repeat the deltas it already holds. The snapshot's text is used only where the store has no delta-built text yet.
 */
function copyAssistantWithDelta(
  previous: Omp.AssistantMessage | undefined,
  candidate: Omp.AssistantMessage,
  update: Omp.AssistantMessageEvent,
): Omp.AssistantMessage {
  const event = update as { type: string; contentIndex?: unknown; delta?: unknown };
  const block = streamedBlockOf(event.type);
  const index = event.contentIndex;
  if (block === undefined || typeof index !== "number") return cloneValue(candidate);
  const content = candidate.content.map((part) => cloneValue(part));
  const candidatePart = content[index];
  if (!isRecord(candidatePart) || candidatePart.type !== block.partType) {
    return cloneValue(candidate);
  }
  const delta = typeof event.delta === "string" ? event.delta : undefined;
  if (event.type.endsWith("_start")) {
    candidatePart[block.field] = "";
  } else if (delta !== undefined) {
    const previousPart = previous?.content[index];
    const built =
      isRecord(previousPart) &&
      previousPart.type === block.partType &&
      typeof previousPart[block.field] === "string"
        ? (previousPart[block.field] as string)
        : undefined;
    const shown =
      typeof candidatePart[block.field] === "string" ? (candidatePart[block.field] as string) : "";
    const base =
      built ?? (shown.endsWith(delta) ? shown.slice(0, shown.length - delta.length) : shown);
    candidatePart[block.field] = `${base}${delta}`;
  } else {
    return cloneValue(candidate);
  }
  return { ...cloneValue(candidate), content };
}

/**
 * A draft of the snapshot for one event. The order is left out: Immer would copy and freeze the whole array on every commit
 * (7 ms at 27,400 messages), so `commit` sets the store's order on the snapshot it publishes.
 */
function mutableSnapshot(snapshot: RuntimeSnapshot): MutableSnapshot {
  const { messageOrder: _order, ...rest } = snapshot;
  return createDraft(rest) as unknown as MutableSnapshot;
}

function makeInitialSnapshot(threadId: ThreadId): RuntimeSnapshot {
  const processGeneration = 0;
  return Object.freeze({
    ...freezeDeep({
      threadId,
      processId: processIdForGeneration(threadId, processGeneration),
      processGeneration,
      revision: 0,
      lastSeq: 0,
      needsRefetch: false,
      transcript: { entries: {}, order: [], head: null, hasOlder: false },
      streaming: {},
      messageOrder: [],
      pendingEnded: [],
      pendingPrompts: [],
      prompt: EMPTY_PROMPT,
      queue: EMPTY_QUEUE,
      commands: [],
      todoPhases: EMPTY_TODOS,
      todoReminders: EMPTY_REMINDERS,
      pending: EMPTY_PENDING,
      process: EMPTY_PROCESS,
      session: EMPTY_SESSION,
      error: null,
    }),
    // The records are views (see `viewOf`), attached after the freeze, which would otherwise freeze them as plain objects.
    messages: viewOf<MessageKey, RuntimeMessage>(
      new ChunkedRecord<RuntimeMessage>({ chunkOf: new Map(), openChunk: 0, openKeys: 0 }, []),
    ),
    tools: viewOf<ToolCallId, ToolCallState>(
      new ChunkedRecord<ToolCallState>({ chunkOf: new Map(), openChunk: 0, openKeys: 0 }, []),
    ),
  });
}

function pendingMessageForKey(
  snapshot: Pick<RuntimeSnapshot, "messages">,
  key: ProvisionalMessageKey,
): RuntimeMessage | undefined {
  return snapshot.messages[key];
}

/** What a `!` command's own transcript entry says: its command, its output, and when omp wrote it. */
interface BashMessageFacts {
  readonly command: string;
  readonly output: string;
  readonly timestamp: number | undefined;
}

function bashMessageOf(raw: unknown): BashMessageFacts | undefined {
  if (!isRecord(raw) || raw.type !== "message") return undefined;
  const message = isRecord(raw.message) ? raw.message : undefined;
  if (message === undefined || message.role !== "bashExecution") return undefined;
  if (typeof message.command !== "string" || typeof message.output !== "string") return undefined;
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
  return { command: message.command, output: message.output, timestamp };
}

/** omp's answer as a `bash` event carries it; undefined when the event has none or it is malformed. */
function bashResultOf(value: unknown): BashCommandResult | undefined {
  if (!isRecord(value) || typeof value.output !== "string") return undefined;
  if (typeof value.cancelled !== "boolean" || typeof value.truncated !== "boolean")
    return undefined;
  const exitCode = typeof value.exitCode === "number" ? value.exitCode : undefined;
  return {
    output: value.output,
    cancelled: value.cancelled,
    truncated: value.truncated,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

/**
 * Whether the transcript's newest entry is the entry of a command that has just ended: the same command and output, written
 * after the command started. An older entry of an identical command was written before it, so it does not match.
 */
function isPersistedCommand(
  next: MutableSnapshot,
  command: string,
  result: BashCommandResult | undefined,
  startedAt: number,
): boolean {
  if (result === undefined || next.transcript.head === null) return false;
  const head = next.transcript.entries[next.transcript.head];
  const message = head === undefined ? undefined : bashMessageOf(head.raw);
  return (
    message !== undefined &&
    message.command === command &&
    message.output === result.output &&
    message.timestamp !== undefined &&
    message.timestamp >= startedAt
  );
}

/**
 * The key of a `!` command's row: the same from its running event to its ended event, and on to its entry, which takes it
 * when the transcript read settles the command (`settleEndedCommands`).
 */
export function commandRowKey(seq: number): MessageKey {
  return `stream:bash:${seq}`;
}

/**
 * Removes the finished row of each `!` command whose entry was just read: the first ended command with that text and, when
 * omp answered, that output. A command whose call failed has no output to match, so its text alone decides. Returns the row
 * key of each settled command by its entry's id, so that entry takes the row's key (`hydratePersistedMessages`).
 */
function settleEndedCommands(
  next: MutableSnapshot,
  entries: readonly TranscriptEntry[],
): Map<EntryId, MessageKey> {
  const rowKeys = new Map<EntryId, MessageKey>();
  for (const entry of entries) {
    const message = bashMessageOf(entry.raw);
    if (message === undefined) continue;
    const settled = next.commands.find(
      (command) =>
        command.phase === "ended" &&
        command.command === message.command &&
        (command.result === undefined || command.result.output === message.output),
    );
    if (settled === undefined) continue;
    rowKeys.set(entry.id, commandRowKey(settled.seq));
    next.commands = next.commands.filter((command) => command !== settled);
  }
  return rowKeys;
}

function entryFromUnknown(value: unknown): TranscriptEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = asEntryId(value.id);
  const type = asString(value.type);
  if (!id || !type) return undefined;
  const parentId = value.parentId === null ? null : (asEntryId(value.parentId) ?? null);
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  return { id, parentId, type, timestamp, raw: cloneValue(value) };
}

function entriesFromUnknown(values: readonly unknown[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const value of values) {
    const entry = entryFromUnknown(value);
    if (entry) entries.push(entry);
  }
  return entries;
}

function messageIdForEvent(
  event: { messageId?: string },
  seq: number,
  generated: number,
): OmpStreamMessageId {
  return (asString(event.messageId) ?? `anonymous-${seq}-${generated}`) as OmpStreamMessageId;
}

function addOrReplaceMessage(next: MutableSnapshot, key: MessageKey, value: RuntimeMessage): void {
  next.messages = recordWith(next.messages, key, value);
  setStreamingCopy(next, key, value);
}

/** A message that is still streaming, or ended but not yet saved, keeps its streamed copy in `streaming`. */
function setStreamingCopy(next: MutableSnapshot, key: MessageKey, value: RuntimeMessage): void {
  const streaming = next.streaming as Record<string, RuntimeMessage>;
  if (value.status === "streaming" || value.status === "ended") {
    if (key.startsWith("stream:")) streaming[key] = value;
  } else {
    delete streaming[key];
  }
}

/** Drops a message's record and its streamed copy. Its place in the order is the caller's to change. */
function removeMessage(next: MutableSnapshot, key: MessageKey): void {
  next.messages = recordWithout(next.messages, key);
  delete (next.streaming as Record<string, RuntimeMessage>)[key];
}

/** A new order with `count` entries from `start` replaced by `items`. A published order is never changed in place. */
function spliced(
  order: readonly MessageKey[],
  start: number,
  count: number,
  ...items: MessageKey[]
): MessageKey[] {
  const copy = order.slice();
  copy.splice(start, count, ...items);
  return copy;
}

/** The order with `key` replaced in place by `replacement`; the same order when `key` is not in it. */
function replacedInOrder(
  order: readonly MessageKey[],
  key: MessageKey,
  replacement: MessageKey,
): readonly MessageKey[] {
  const index = order.indexOf(key);
  return index < 0 ? order : spliced(order, index, 1, replacement);
}

/** The row a message keeps as it streams and ends: the row it took the place of, so its element is not replaced. */
function keptRowKey(next: MutableSnapshot, key: MessageKey): { readonly rowKey?: MessageKey } {
  const previous: RuntimeMessage | undefined = next.messages[key];
  const rowKey = previous?.rowKey;
  return rowKey === undefined ? {} : { rowKey };
}

/** Takes the rows of pending prompts out of the list and the store: omp will not echo them, or the person took them back. */
function removePendingPrompts(next: MutableSnapshot, keys: readonly MessageKey[]): void {
  next.pendingPrompts = next.pendingPrompts.filter((pending) => !keys.includes(pending.key));
  for (const key of keys) removeMessage(next, key);
}

/** The keys of the rows still waiting for omp's echo, oldest first. */
function pendingKeysOf(next: MutableSnapshot): MessageKey[] {
  return next.pendingPrompts.map((pending) => pending.key);
}

/**
 * The position in `order` of the row the history already shows for `message`: a row with the same role and timestamp that is
 * not streamed; -1 when none. `copies` holds those rows by copy key (`hydratePersistedMessages` keeps it), so this costs no
 * scan of the chat.
 */
function shownCopyIndex(
  next: MutableSnapshot,
  copies: ReadonlyMap<string, MessageKey>,
  order: readonly MessageKey[],
  key: MessageKey,
  message: OmpMessage,
): number {
  if (next.messages[key] !== undefined) return -1;
  const copyKey = streamedCopyKey(message);
  const shownKey = copyKey === undefined ? undefined : copies.get(copyKey);
  if (copyKey === undefined || shownKey === undefined) return -1;
  const shown: RuntimeMessage | undefined = next.messages[shownKey];
  if (shown === undefined || shown.streamMessageId !== undefined) return -1;
  if (streamedCopyKey(shown.message) !== copyKey) return -1;
  return order.indexOf(shownKey);
}

/**
 * The row a reminder that arrives now follows, or null when the transcript is empty. A tool result is not a row of its
 * own: assistant-ui joins it into the answer that called the tool, and a row closes only at an assistant output
 * (`convertExternalMessage`). So a reminder after tool results names that answer, and the answer after the reminder
 * starts a row of its own (issue 1522).
 */
function reminderRowId(next: MutableSnapshot, order: readonly MessageKey[]): MessageKey | null {
  const last = order.at(-1);
  if (last === undefined) return null;
  let answer: RuntimeMessage | undefined;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const record = next.messages[order[index] as MessageKey];
    if (record?.message.role !== "toolResult") {
      answer = record;
      break;
    }
  }
  if (answer?.message.role === "assistant") return rowIdOf(answer);
  const record = next.messages[last];
  return record === undefined ? last : rowIdOf(record);
}

function updatePrompt(
  next: MutableSnapshot,
  update: Partial<PromptLifecycleState> & { promptResult?: PromptResultState | null },
): void {
  const previous = next.prompt;
  const promptResults = update.promptResult
    ? [...previous.promptResults, update.promptResult].slice(-MAX_PROMPT_RESULTS)
    : previous.promptResults;
  const prompt: PromptLifecycleState = {
    admitted: update.admitted ?? previous.admitted,
    streaming: update.streaming ?? previous.streaming,
    sent: update.sent ?? previous.sent,
    promptResult: update.promptResult === undefined ? previous.promptResult : update.promptResult,
    sessionSettled: update.sessionSettled ?? previous.sessionSettled,
    promptResults,
  };
  next.prompt = prompt;
}

function updateQueues(next: MutableSnapshot, queue: Partial<QueueState>): void {
  const previous = next.queue;
  const nextQueue: QueueState = {
    steering: queue.steering ? [...queue.steering] : [...previous.steering],
    followUp: queue.followUp ? [...queue.followUp] : [...previous.followUp],
    steeringMode: queue.steeringMode ?? previous.steeringMode,
    followUpMode: queue.followUpMode ?? previous.followUpMode,
    interruptMode: queue.interruptMode ?? previous.interruptMode,
    liveSteered: queue.liveSteered ?? previous.liveSteered,
  };
  next.queue = nextQueue;
}

/** omp 18.9 counts the leading steering messages it already sent into the reply; 0 when the field is absent. */
function liveSteeredOf(message: unknown): number {
  if (typeof message !== "object" || message === null || !("liveSteered" in message)) return 0;
  const count = message.liveSteered;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}

function updateTodos(next: MutableSnapshot, phases: readonly TodoPhase[]): void {
  const copied = cloneValue(phases) as TodoPhase[];
  next.todoPhases = copied;
}

/** The phases a successful `todo` tool result carries; undefined for `view`, errors and other tools. */
function todoPhasesFromResult(
  toolName: string,
  isError: boolean,
  result: unknown,
): TodoPhase[] | undefined {
  if (toolName !== "todo" || isError || !isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  const { op, phases } = result.details;
  if (op === "view" || !Array.isArray(phases)) return undefined;
  return phases as TodoPhase[];
}

function setProcess(
  next: MutableSnapshot,
  status: ProcessState["status"],
  error?: AppError,
  startedAt?: number,
): void {
  const processError = error
    ? cloneValue(error)
    : status === "error" || status === "exited"
      ? errorForProcess(status)
      : null;
  // A frame that does not say when its process started keeps the time the last one gave.
  const since = startedAt ?? next.process.startedAt;
  next.process = {
    status,
    error: processError,
    ...(since === undefined ? {} : { startedAt: since }),
  };
  if (processError) next.error = processError;
  else if (status === "ready" || status === "running" || status === "starting") {
    if (next.error?.heading !== EXTENSION_ERROR_HEADING) next.error = null;
  }
}

function cancelActiveTools(next: MutableSnapshot): void {
  for (const [key, tool] of Object.entries(next.tools)) {
    const toolCallId = asToolCallId(key);
    if (toolCallId !== undefined && (tool.status === "running" || tool.status === "partial")) {
      next.tools = recordWith(next.tools, toolCallId, { ...tool, status: "cancelled" });
    }
  }
}

/** A host that exited can take no answer: its dialogs are no longer open, and the router closes them. */
function dropDialogs(next: MutableSnapshot): void {
  const pending = copyPending(next);
  pending.dialogs = {};
  setPending(next, pending);
}

function recordTranscriptEntry(next: MutableSnapshot, entry: TranscriptEntry): void {
  const entries = next.transcript.entries as Record<string, TranscriptEntry>;
  const order = next.transcript.order as EntryId[];
  const previous = entries[entry.id];
  if (!previous) order.push(entry.id);
  entries[entry.id] =
    previous?.messageKey !== undefined && entry.messageKey === undefined
      ? { ...entry, messageKey: previous.messageKey }
      : entry;
  next.transcript = { ...next.transcript, entries, order, head: entry.id };
}
function mergeEntryMessageKey(next: MutableSnapshot, entryId: EntryId, key: MessageKey): void {
  const current = next.transcript.entries[entryId];
  if (!current) return;
  const entries = next.transcript.entries as Record<string, TranscriptEntry>;
  entries[entryId] = { ...current, messageKey: key };
}

/** The entries from the root to `head` (the branch the session is on), oldest first, after the latest omp reset boundary (`session-context.ts:461-480` at v18.9.1). */
function activeBranch(transcript: TranscriptState): readonly EntryId[] {
  if (transcript.head === null) return transcript.order;
  const path: EntryId[] = [];
  const seen = new Set<EntryId>();
  let current: EntryId | null = transcript.head;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const entry: TranscriptEntry | undefined = transcript.entries[current];
    if (!entry) break;
    path.push(current);
    current = entry.parentId;
  }
  path.reverse();
  const boundary = path.findLastIndex(
    (entryId) => transcript.entries[entryId]?.type === "reset_boundary",
  );
  return boundary < 0 ? path : path.slice(boundary + 1);
}

/**
 * The message an omp session entry carries, if any: a `message` entry holds one, and a
 * `custom_message` entry is one (omp stores a custom message's `customType`, `content`, `display`
 * and `details` on the entry, and its time as ISO text: session/session-manager.ts:3446-3465).
 */
function messageFromEntry(entry: TranscriptEntry): OmpMessage | undefined {
  if (!isRecord(entry.raw)) return undefined;
  if (entry.type === "custom_message") return customMessageFromEntry(entry.raw);
  if (entry.type === "branch_summary") return branchSummaryFromEntry(entry.raw);
  if (entry.type === "compaction") return compactionFromEntry(entry.raw);
  if (entry.type !== "message") return undefined;
  const message = entry.raw.message;
  if (!isRecord(message) || typeof message.role !== "string") return undefined;
  return cloneValue(message) as unknown as OmpMessage;
}

function customMessageFromEntry(raw: Record<string, unknown>): OmpMessage | undefined {
  const { customType, content, timestamp } = raw;
  if (typeof customType !== "string" || typeof timestamp !== "string") return undefined;
  if (typeof content !== "string" && !Array.isArray(content)) return undefined;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return undefined;
  return cloneValue({
    role: "custom",
    customType,
    content,
    display: raw.display === true,
    timestamp: time,
    ...(raw.details === undefined ? {} : { details: raw.details }),
  }) as unknown as OmpMessage;
}

/**
 * omp's branch summary: the summary of a branch someone left, with the id it left from. omp also
 * writes one with an empty summary as an internal discard marker, which its own context skips
 * (`packages/coding-agent/src/session/session-context.ts:410`), so an empty one is not a message.
 */
function branchSummaryFromEntry(raw: Record<string, unknown>): OmpMessage | undefined {
  const { fromId, summary, timestamp } = raw;
  if (typeof summary !== "string" || summary.length === 0) return undefined;
  if (typeof fromId !== "string" || typeof timestamp !== "string") return undefined;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return undefined;
  return cloneValue({
    role: "branchSummary",
    summary,
    fromId,
    timestamp: time,
  }) as unknown as OmpMessage;
}

/**
 * omp's compaction summary and its optional display metadata.
 * `warning` is a typed `CompactionEntry` field in omp v18.12.6:
 * `packages/coding-agent/src/session/session-entries.ts:144-168`.
 */
function compactionFromEntry(raw: Record<string, unknown>): OmpMessage | undefined {
  const { summary, shortSummary, tokensBefore, tokensAfter, method, timestamp, warning } = raw;
  if (typeof summary !== "string" || typeof tokensBefore !== "number") return undefined;
  if (typeof timestamp !== "string") return undefined;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return undefined;
  return cloneValue({
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: time,
    ...(typeof shortSummary === "string" ? { shortSummary } : {}),
    ...(typeof tokensAfter === "number" ? { tokensAfter } : {}),
    ...(typeof method === "string" ? { method } : {}),
    ...(typeof warning === "string" ? { warning } : {}),
  }) as unknown as OmpMessage;
}

/**
 * omp sets a message's role and timestamp at `message_start` and its session entry keeps both, so
 * they identify a streamed message's entry even before `message_end` (C0's identity rule needs the
 * final stop reason, which a streaming message does not have yet).
 */
function streamedCopyKey(message: OmpMessage): string | undefined {
  if (!("timestamp" in message) || typeof message.timestamp !== "number") return undefined;
  return message.role === "toolResult"
    ? `${message.role}:${message.timestamp}:${message.toolCallId}`
    : `${message.role}:${message.timestamp}`;
}

/**
 * The records one history pass writes, applied together. Writing them one at a time copies a chunk of the record for each
 * write, and a pass over a long chat's history writes most of its chunks, so the pass collects its writes and applies them
 * once (`apply`), which copies each chunk once.
 */
class MessageWrites {
  private readonly next: MutableSnapshot;
  private readonly pending = new Map<MessageKey, RuntimeMessage>();

  constructor(next: MutableSnapshot) {
    this.next = next;
  }

  /** The record as the pass sees it: a record the pass wrote, else the record in the store. */
  get(key: MessageKey): RuntimeMessage | undefined {
    const written: RuntimeMessage | undefined = this.pending.get(key);
    return written ?? this.next.messages[key];
  }

  /** Records a write for `apply`; its streamed copy is kept as `addOrReplaceMessage` keeps it. */
  set(key: MessageKey, value: RuntimeMessage): void {
    this.pending.set(key, value);
    setStreamingCopy(this.next, key, value);
  }

  /** Applies every write of the pass to the record, in one copy. */
  apply(): void {
    this.next.messages = recordWithMany(this.next.messages, this.pending);
  }
}

/**
 * History holds the message the stream still shows as streaming: omp persisted it, so its end was missed (a
 * gap in the stream), and the history's copy is the ended message. The stand-in takes that copy and ends, so
 * it settles; it pairs with its entry at the next pairing, as a message_end would. A message_end that still
 * arrives finds the same stand-in.
 */
function settleStreamedCopy(
  next: MutableSnapshot,
  writes: MessageWrites,
  key: MessageKey,
  message: OmpMessage,
): void {
  const record = writes.get(key);
  if (record?.status !== "streaming") return;
  writes.set(key, { ...record, message, status: "ended" });
  const pending = next.pendingEnded as ProvisionalMessageKey[];
  const provisional = key as ProvisionalMessageKey;
  if (!pending.includes(provisional)) pending.push(provisional);
}

/**
 * Where the live messages that history does not return go. A message still waiting for its entry is the newest and
 * goes last. An answer cut off by the process exiting is different: omp never saved it, so history never returns it,
 * and moving it behind the answers that came after would glue its text onto the next turn's answer. It keeps its
 * place, right after the message it followed. A live voice line is the same case: omp never keeps it, so it keeps its
 * place too (see `isVoiceLine`).
 */
function placeLiveMessages(
  previousOrder: readonly MessageKey[],
  viewOrder: readonly MessageKey[],
  live: readonly MessageKey[],
  isCutOff: (key: MessageKey) => boolean,
): MessageKey[] {
  const placed = [...viewOrder];
  const last: MessageKey[] = [];
  for (const key of live) {
    const before = previousOrder.indexOf(key);
    if (!isCutOff(key) || before < 0) {
      last.push(key);
      continue;
    }
    // The nearest earlier message that is still in the view; with none before it, the answer was the first.
    let after = before === 0 ? -1 : undefined;
    for (let index = before - 1; index >= 0 && after === undefined; index -= 1) {
      const found = placed.lastIndexOf(previousOrder[index] as MessageKey);
      if (found >= 0) after = found;
    }
    if (after === undefined) last.push(key);
    else placed.splice(after + 1, 0, key);
  }
  return [...placed, ...last];
}

/**
 * A live voice line (`admitVoiceTurn`): omp keeps no message for it, so a settled turn's history never returns it.
 * It stays where it was admitted (see `placeLiveMessages`), not behind the history that settles after it.
 */
function isVoiceLine(record: RuntimeMessage | undefined): boolean {
  return record?.streamMessageId?.startsWith("voice:") === true;
}

/**
 * Shows the persisted history of the active branch: every `message` entry on it becomes a persisted
 * message, in branch order, followed by the live messages omp has not persisted yet. A live message
 * already paired to an entry keeps its record; one not paired yet stands in for its entry (so a
 * message never shows twice while its `message_end` and the history race). Persisted messages of
 * other branches leave the view. `order` is the store's message order, and the order it returns
 * replaces it. `copies` is refilled with the history rows the view shows, by copy key (`shownCopyIndex`).
 */
function hydratePersistedMessages(
  next: MutableSnapshot,
  order: readonly MessageKey[],
  copies: Map<string, MessageKey>,
  rowKeys: ReadonlyMap<EntryId, MessageKey> = new Map(),
): readonly MessageKey[] {
  const unpairedLive = new Map<string, MessageKey>();
  for (const key of order) {
    const record = next.messages[key];
    if (!key.startsWith("stream:") || record === undefined || record.entryId !== undefined)
      continue;
    const copyKey = streamedCopyKey(record.message);
    if (copyKey !== undefined) unpairedLive.set(copyKey, key);
  }
  const takeLiveCopy = (message: OmpMessage | undefined): MessageKey | undefined => {
    const copyKey = message === undefined ? undefined : streamedCopyKey(message);
    const live = copyKey === undefined ? undefined : unpairedLive.get(copyKey);
    if (copyKey !== undefined && live !== undefined) unpairedLive.delete(copyKey);
    return live;
  };

  const writes = new MessageWrites(next);
  const viewOrder: MessageKey[] = [];
  for (const entryId of activeBranch(next.transcript)) {
    const entry = next.transcript.entries[entryId];
    if (!entry) continue;
    const current = entry.messageKey === undefined ? undefined : writes.get(entry.messageKey);
    if (current?.streamMessageId !== undefined) {
      viewOrder.push(current.key);
      continue;
    }
    const message = current?.message ?? messageFromEntry(entry);
    const live = takeLiveCopy(message);
    if (live !== undefined) {
      if (message !== undefined) settleStreamedCopy(next, writes, live, message);
      viewOrder.push(live);
      continue;
    }
    if (current !== undefined) {
      viewOrder.push(current.key);
      continue;
    }
    if (!message) continue;
    const key = persistedMessageKey(next.threadId, entryId);
    const rowKey = rowKeys.get(entryId);
    writes.set(key, {
      key,
      message,
      status: "persisted",
      entryId,
      parentId: entry.parentId,
      ...(rowKey === undefined ? {} : { rowKey }),
    });
    mergeEntryMessageKey(next, entryId, key);
    viewOrder.push(key);
  }
  writes.apply();
  const shown = new Set<MessageKey>(viewOrder);
  const live = order.filter((key) => !shown.has(key) && key.startsWith("stream:"));
  const placed = placeLiveMessages(
    order,
    viewOrder,
    live,
    (key) => next.messages[key]?.interrupted === true || isVoiceLine(next.messages[key]),
  );
  copies.clear();
  for (const key of placed) {
    const record = next.messages[key];
    if (record === undefined || record.streamMessageId !== undefined) continue;
    const copyKey = streamedCopyKey(record.message);
    if (copyKey !== undefined && !copies.has(copyKey)) copies.set(copyKey, key);
  }
  return placed;
}

interface PendingDraft {
  dialogs: Record<string, PendingDialog>;
  hostTools: Record<string, PendingHostToolRequest>;
  hostUris: Record<string, PendingHostUriRequest>;
}

function copyPending(next: MutableSnapshot): PendingDraft {
  return {
    dialogs: { ...next.pending.dialogs },
    hostTools: { ...next.pending.hostTools },
    hostUris: { ...next.pending.hostUris },
  };
}

function setPending(next: MutableSnapshot, pending: PendingDraft): void {
  next.pending = pending;
}

function setError(next: MutableSnapshot, error: ChatFailure): void {
  next.error = cloneValue(error);
}

/** The banner's heading for an extension's error, and for an error omp reports itself. */
const EXTENSION_ERROR_HEADING = "An extension reported an error";
const NOTICE_ERROR_HEADING = "omp reported a problem";

/**
 * omp announces every change to a session's goal with `goal_updated`: `goal` is the goal (null once it is dropped) and
 * `state` the goal mode, when the mode changed (omp's `rpc-types.ts` event). `session.goal` follows it, so a reader of
 * the goal (the status bar, the guided goal) sees a goal that was created, paused, resumed, dropped or completed without
 * a `get_state`. An update with no mode keeps the mode the store holds and replaces the goal in it (a usage update); with
 * no mode held, nothing is known to keep, and the next `get_state` supplies it.
 */
function reduceGoalUpdated(next: MutableSnapshot, frame: Record<string, unknown>): void {
  const { goal, state } = frame;
  let updated: SessionState["goal"];
  if (isRecord(state) && isRecord(state.goal)) {
    updated = cloneValue(state) as unknown as Omp.GoalModeState;
  } else if (goal === null) {
    updated = null;
  } else if (isRecord(goal) && next.session.goal) {
    updated = { ...next.session.goal, goal: cloneValue(goal) as unknown as Omp.Goal };
  } else {
    return;
  }
  next.session = { ...next.session, goal: updated, revision: next.session.revision + 1 };
}

/** The name a person knows an extension by: its file's name, or its folder's when the file is `index`. */
function extensionNameOf(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  const file = parts.at(-1)?.replace(/\.[^.]+$/, "");
  if (file !== "index") return file || undefined;
  return parts.at(-2) || undefined;
}

/**
 * Clears the error omp reported for earlier work (a failed prompt, a notice) when a new run starts. The process's own
 * failure stays: a run cannot start while the process is down, and the process clears its own failure when it is ready.
 */
function clearEarlierOmpError(next: MutableSnapshot): void {
  if (!next.process.error && next.error?.code === "omp_error") next.error = null;
}

const TOOL_LIFECYCLE_EVENTS: Record<string, true> = {
  tool_execution_start: true,
  tool_execution_update: true,
  tool_stream_update: true,
  tool_execution_end: true,
};

/** omp's events for one tool call's execution: live facts that no history read holds. */
function isToolLifecycleEvent(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.type === "string" && TOOL_LIFECYCLE_EVENTS[value.type] === true
  );
}

/** The states a call keeps once it has ended: a later tool update adds progress, but never makes the call running again. */
const ENDED_TOOL_STATUSES: Record<string, true> = { success: true, error: true, cancelled: true };

const PROMPT_LIFECYCLE_EVENTS: Record<string, true> = {
  agent_start: true,
  turn_start: true,
  message_start: true,
  message_end: true,
  turn_end: true,
  agent_end: true,
};

/** Whether an applied event sets the prompt lifecycle (`prompt.streaming`, `admitted`, `sessionSettled`). */
function setsPromptLifecycle(eventValue: Record<string, unknown>): boolean {
  if (eventValue.kind === "prompt_result" || eventValue.kind === "session_settled") return true;
  const event = eventValue.event;
  return (
    eventValue.kind === "omp" &&
    isRecord(event) &&
    typeof event.type === "string" &&
    PROMPT_LIFECYCLE_EVENTS[event.type] === true
  );
}

/**
 * The single reducer of normalized omp events for one open thread.
 *
 * This class has no React dependency. It is intentionally usable by Bun/Vitest fixtures and can be
 * passed directly to `useSyncExternalStore`/`useExternalStoreRuntime` by a later R0 part.
 */
export class OmpRuntimeStore {
  private snapshot: RuntimeSnapshot;
  private readonly listeners = new Set<RuntimeStoreListener>();
  private readonly transport: OmpRuntimeTransport;
  private readonly notificationSubscriptions = new Set<NotificationSubscription>();
  private readonly ompEventSubscriptions = new Set<OmpEventSubscription>();
  private readonly streamKeys = new Map<string, ProvisionalMessageKey>();
  private generatedMessageNumber = 0;
  /** The highest seq ever passed to `ingest`, including events dropped during a gap. */
  private latestSeenSeq = 0;
  /** The seq of the last applied event that set the prompt lifecycle: a run starting, admitted or ending. */
  private promptEventSeq = 0;
  /** Sequences the passthrough delivered across a gap, so a replay of one is not delivered again. */
  private readonly forwardedAcrossGap = new Set<number>();
  /** Presentation frames no listener was attached for when they arrived: kept for the first listener (`subscribeNotifications`). */
  private undeliveredFrames: UndeliveredFrame[] = [];
  /** Omp events no listener was attached for when they arrived: kept for the first listener (`subscribeOmpEvents`). */
  private undeliveredEvents: UndeliveredEvent[] = [];
  /** The message order (`messageOrder` of the snapshot). A change makes a new array: a published order is never changed in place. */
  private order: readonly MessageKey[];
  /** The history rows the view shows, by copy key (see `shownCopyIndex`); `hydratePersistedMessages` refills it. */
  private readonly historyCopies = new Map<string, MessageKey>();

  public constructor(options: OmpRuntimeStoreOptions);
  public constructor(threadId: ThreadId, options?: Omit<OmpRuntimeStoreOptions, "threadId">);
  public constructor(
    optionsOrThreadId: OmpRuntimeStoreOptions | ThreadId,
    options?: Omit<OmpRuntimeStoreOptions, "threadId">,
  ) {
    const config =
      typeof optionsOrThreadId === "string"
        ? { ...options, threadId: optionsOrThreadId }
        : optionsOrThreadId;
    this.snapshot = makeInitialSnapshot(config.threadId);
    this.order = this.snapshot.messageOrder;
    this.transport = config.transport ?? {};
  }

  public getSnapshot(): RuntimeSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: RuntimeStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Forward selected raw notification frames to feature modules without making them second
   * reducers of runtime state. The sequence gate in `ingest` provides ordering and de-duplication;
   * across a gap, `forwardAcrossGap` de-duplicates.
   */
  public subscribeNotifications(
    types: readonly string[],
    listener: RuntimeNotificationListener,
  ): () => void {
    const subscription: NotificationSubscription = {
      types: new Set(types),
      listener,
    };
    this.notificationSubscriptions.add(subscription);
    // A presentation frame that arrived before a listener of its type was attached is given to this one, once, in order.
    // A chat's start-up frames are applied as its stream opens, which can be before its page subscribes (issue 2181).
    const waiting: UndeliveredFrame[] = [];
    const kept: UndeliveredFrame[] = [];
    for (const item of this.undeliveredFrames) {
      if (subscription.types.has(item.type)) waiting.push(item);
      else kept.push(item);
    }
    this.undeliveredFrames = kept;
    for (const item of waiting) listener(item.frame, item.seq, item.replayed);
    return () => this.notificationSubscriptions.delete(subscription);
  }

  /**
   * Forward selected Omp events only after their contiguous event has been committed to this store.
   * `undefined` subscribes to every applied Omp event; an empty list subscribes to none.
   */
  public subscribeOmpEvents(
    types: readonly string[] | undefined,
    listener: RuntimeOmpEventListener,
  ): () => void {
    const subscription: OmpEventSubscription = {
      types: types === undefined ? undefined : new Set(types),
      listener,
    };
    this.ompEventSubscriptions.add(subscription);
    // Events that arrived before any listener was attached are given to this one, once, in order (see `forwardOmpEvent`).
    const waiting: UndeliveredEvent[] = [];
    const kept: UndeliveredEvent[] = [];
    for (const item of this.undeliveredEvents) {
      if (subscription.types === undefined || subscription.types.has(item.event.type))
        waiting.push(item);
      else kept.push(item);
    }
    this.undeliveredEvents = kept;
    for (const item of waiting) listener(item.event, item.seq, item.replayed);
    return () => this.ompEventSubscriptions.delete(subscription);
  }

  /**
   * Apply exactly one contiguous event of the chat session port. Replays are ignored. A gap is not applied: the caller
   * must refetch history and call `resetSequence` before the next event can change state, except that a request omp is
   * waiting on is recorded anyway (`ingestAcrossGap`). Every seq is remembered (`latestSeenSeq`) so the refetch resumes
   * where the stream really is.
   *
   * `fromHistory` marks an event that a subscription from the stream's start replays before it is acknowledged. Such an
   * event is applied, except one that asks the person something (a question, a host call, a sign-in prompt): a replay
   * cannot say whether such a request was answered since, so it is not asked again. The questions a chat's omp still
   * waits on are recorded from the server's record instead (`recordOpenQuestion`).
   *
   * The payload is sorted once here (`store-events.ts`): omp's events, the frames handed on by type, a prompt's result, the
   * session's settle, a `!` run and the process's state.
   */
  public ingest(payload: ChatSessionEvent, seq: number, fromHistory = false): void {
    this.ingestEvent(storeEventOf(payload), seq, fromHistory);
  }

  private ingestEvent(event: StoreEvent, seq: number, fromHistory: boolean): void {
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new RangeError("event seq must be a positive safe integer");
    }
    if (seq > this.latestSeenSeq) this.latestSeenSeq = seq;
    if (seq <= this.snapshot.lastSeq) return;
    const eventValue = event as unknown as Record<string, unknown>;
    const askingFromHistory =
      fromHistory && eventValue.kind === "notification" && isAskingFrame(eventValue.frame);
    if (this.snapshot.needsRefetch || seq !== this.snapshot.lastSeq + 1) {
      this.ingestAcrossGap(eventValue, seq, askingFromHistory, fromHistory);
      return;
    }

    const wasForwardedAcrossGap =
      event.kind === "notification" && this.forwardedAcrossGap.delete(seq);
    const next = mutableSnapshot(this.snapshot);
    switch (eventValue.kind) {
      case "omp":
        this.reduceOmp(next, eventValue.event, seq);
        break;
      case "prompt_result":
        this.reducePromptResult(next, eventValue.event);
        break;
      case "bash":
        this.reduceBashCommand(next, eventValue, seq, fromHistory);
        break;
      case "session_settled":
        updatePrompt(next, { sessionSettled: true, streaming: false });
        cancelActiveTools(next);
        break;
      case "notification":
        if (!askingFromHistory) this.reduceNotification(next, eventValue.frame, seq);
        break;
      case "process": {
        const status = eventValue.status;
        if (
          typeof status === "string" &&
          PROCESS_STATUSES[status as ProcessState["status"]] === true
        ) {
          this.reduceProcess(
            next,
            status as ProcessState["status"],
            isRecord(eventValue.error) ? (cloneValue(eventValue.error) as AppError) : undefined,
            typeof eventValue.startedAt === "number" ? eventValue.startedAt : undefined,
          );
        }
        break;
      }
      default:
        // A payload the store holds no state for (`other`) keeps its sequence slot.
        break;
    }
    if (setsPromptLifecycle(eventValue)) this.promptEventSeq = seq;
    next.lastSeq = seq;
    this.commit(next);
    if (event.kind === "omp") {
      this.forwardOmpEvent(event.event, seq, fromHistory);
      // omp's RPC session classified a goal update as an omp event while D8 listens for it as a frame, so a goal that
      // changed during a run never reached the goal panel (found in H5.4a). It is handed on as a frame too.
      if (event.event.type === "goal_updated")
        this.forwardNotification(event.event, seq, fromHistory);
    }
    if (event.kind === "notification" && !askingFromHistory && !wasForwardedAcrossGap)
      this.forwardNotification(event.frame, seq, fromHistory);
  }

  /**
   * An event that cannot be applied in order: the stream has a gap, or a refetch is still running.
   * The refetch restores messages and state from omp, but it can never restore what omp is waiting
   * on or what is running now, so a notification (a question, an approval, a host tool call, or the
   * cancellation of one) and a tool call's start, progress and end are recorded anyway; everything
   * else is dropped and covered by the refetch. Dropping the request left omp blocked forever on an
   * answer nobody was shown (a fresh chat's first events predate the browser's subscription, which is
   * a gap by construction). Dropping a tool's start left its card reading Waiting until the call ended.
   * A notification the passthrough does not reduce (a worker's start or end, a goal update) is still
   * delivered, because no refetch restores it either: dropping a worker's end left the Agent Hub
   * showing that worker as running.
   */
  private ingestAcrossGap(
    eventValue: Record<string, unknown>,
    seq: number,
    askingFromHistory: boolean,
    fromHistory: boolean,
  ): void {
    const next = mutableSnapshot(this.snapshot);
    const rawFrame = eventValue.frame;
    // A question or host call from the history is not recorded (see `ingest`).
    const isNotification = eventValue.kind === "notification" && !askingFromHistory;
    if (isNotification) this.reduceNotification(next, rawFrame, seq);
    const toolEvent = eventValue.kind === "omp" && isToolLifecycleEvent(eventValue.event);
    if (toolEvent) this.reduceOmp(next, eventValue.event, seq);
    const bashEvent = eventValue.kind === "bash";
    if (bashEvent) this.reduceBashCommand(next, eventValue, seq, fromHistory);
    const recorded =
      toolEvent ||
      bashEvent ||
      next.pending !== this.snapshot.pending ||
      next.error !== this.snapshot.error;
    if (!this.snapshot.needsRefetch || recorded) {
      next.needsRefetch = true;
      this.commit(next);
    }
    // After the commit, so a listener reads the state this event left. A dialog or host call stays out of its router (it
    // is recorded above, and the host's cancel of one drops it from `pending`, which closes it).
    if (isNotification && !isAskingFrame(rawFrame)) {
      this.forwardAcrossGap(rawFrame, seq, fromHistory);
    }
    if (toolEvent) this.forwardOmpEvent(eventValue.event as OmpEvent, seq, fromHistory);
  }

  /**
   * Delivers a passthrough notification that arrived across a gap. A replay can send the same sequence
   * again, and each sequence is delivered once; the record is cleared as the cursor catches up
   * (`resetSequence`).
   */
  private forwardAcrossGap(rawFrame: unknown, seq: number, replayed: boolean): void {
    if (this.forwardedAcrossGap.has(seq)) return;
    this.forwardedAcrossGap.add(seq);
    this.forwardNotification(rawFrame, seq, replayed);
  }

  /**
   * Clear a sequence gap after R0.2 has refetched state and history. By default the cursor moves to
   * the highest seq seen so far: the refetched history already reflects those events, and the next
   * live event then applies contiguously. (Resetting to 0 would turn the next event into a new gap,
   * so a streaming turn would refetch forever.)
   */
  public resetSequence(lastSeq = this.latestSeenSeq): void {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      throw new RangeError("lastSeq must be a non-negative safe integer");
    }
    const next = mutableSnapshot(this.snapshot);
    next.lastSeq = lastSeq;
    next.needsRefetch = false;
    // The cursor now covers these sequences, so the passthrough never meets them again.
    for (const seq of this.forwardedAcrossGap) {
      if (seq <= lastSeq) this.forwardedAcrossGap.delete(seq);
    }
    this.commit(next);
  }

  /** Add history entries and pair every waiting `message_end` by C0's identity rule. */
  public pairEndedMessages(entries: readonly unknown[], leafId?: EntryId | null): void {
    const next = mutableSnapshot(this.snapshot);
    const parsed = entriesFromUnknown(entries);
    const fresh = parsed.filter((entry) => next.transcript.entries[entry.id] === undefined);
    for (const entry of parsed) recordTranscriptEntry(next, entry);
    const rowKeys = settleEndedCommands(next, fresh);
    if (leafId !== undefined) next.transcript = { ...next.transcript, head: leafId };
    this.pairEndedInDraft(next, entries);
    this.order = hydratePersistedMessages(next, this.order, this.historyCopies, rowKeys);
    this.commit(next);
  }

  /**
   * Adds older history entries in front of the transcript: the window before its first entry. The
   * branch head stays where it is, and the view is rebuilt from the branch.
   */
  public prependHistoryEntries(entries: readonly unknown[], hasOlder: boolean): void {
    const next = mutableSnapshot(this.snapshot);
    const transcriptEntries = next.transcript.entries as Record<string, TranscriptEntry>;
    const older = entriesFromUnknown(entries).filter(
      (entry) => transcriptEntries[entry.id] === undefined,
    );
    for (const entry of older) transcriptEntries[entry.id] = entry;
    next.transcript = {
      ...next.transcript,
      order: [...older.map((entry) => entry.id), ...next.transcript.order],
      hasOlder,
    };
    this.order = hydratePersistedMessages(next, this.order, this.historyCopies);
    this.commit(next);
  }

  /** Records whether the session file holds entries older than the transcript's first one. */
  public setHasOlder(hasOlder: boolean): void {
    const next = mutableSnapshot(this.snapshot);
    next.transcript = { ...next.transcript, hasOlder };
    this.commit(next);
  }

  /**
   * Replaces one history entry with its full form (a tool output loaded in full). The entry keeps its
   * place and message key; its message is rebuilt from the full entry and the view is rebuilt from it.
   */
  public replaceHistoryEntry(entry: unknown): void {
    const [parsed] = entriesFromUnknown([entry]);
    if (parsed === undefined) return;
    const next = mutableSnapshot(this.snapshot);
    const transcriptEntries = next.transcript.entries as Record<string, TranscriptEntry>;
    const previous = transcriptEntries[parsed.id];
    if (previous === undefined) return;
    transcriptEntries[parsed.id] = { ...parsed, messageKey: previous.messageKey };
    const key = previous.messageKey;
    const message = messageFromEntry(parsed);
    const record = key === undefined ? undefined : next.messages[key];
    if (key !== undefined && record !== undefined && message !== undefined) {
      addOrReplaceMessage(next, key, { ...record, message });
    }
    this.order = hydratePersistedMessages(next, this.order, this.historyCopies);
    this.commit(next);
  }

  /**
   * Apply the relevant fields of a `get_state` result; no JSONL or wire parsing happens here. `asOfSeq`
   * is the stream position the answer was asked at.
   */
  public applySessionState(
    state: Partial<SessionState>,
    options?: { readonly asOfSeq?: number },
  ): void {
    const next = mutableSnapshot(this.snapshot);
    updateQueues(next, {
      steering: state.queuedMessages?.steering,
      followUp: state.queuedMessages?.followUp,
      liveSteered: liveSteeredOf(state.queuedMessages),
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      interruptMode: state.interruptMode,
    });
    if (state.todoPhases) updateTodos(next, state.todoPhases);
    // The answer describes omp as it was when it was asked. A run that started or ended on the stream after
    // that is newer than the answer, so the answer leaves the prompt lifecycle alone.
    if (options?.asOfSeq === undefined || this.promptEventSeq <= options.asOfSeq) {
      updatePrompt(next, {
        admitted: state.isStreaming === true ? true : undefined,
        streaming: state.isStreaming,
        sessionSettled: state.isSettled,
      });
    }
    // omp answered get_state, so its process is up. When the lifecycle events that announced it are
    // older than the server's replay window, this is the only signal the store gets.
    if (next.process.status === "starting") setProcess(next, "ready");
    const previous = next.session;
    next.session = {
      model: state.model ?? previous.model,
      thinkingLevel: state.thinkingLevel ?? previous.thinkingLevel,
      sessionName: state.sessionName ?? previous.sessionName,
      contextUsage: state.contextUsage ?? previous.contextUsage,
      isCompacting: state.isCompacting ?? previous.isCompacting,
      autoCompactionEnabled: state.autoCompactionEnabled ?? previous.autoCompactionEnabled,
      tokensPerSecond:
        state.tokensPerSecond === undefined ? previous.tokensPerSecond : state.tokensPerSecond,
      goal: state.goal === undefined ? previous.goal : state.goal,
      revision: previous.revision + 1,
    };
    this.commit(next);
  }

  /** Typed action used by U5; the server result remains authoritative. */
  public async setTodos(
    phases: readonly TodoPhase[],
    options?: PortCallOptions,
  ): Promise<readonly TodoPhase[]> {
    if (!this.transport.request) {
      const error = errorForUnavailable("setTodos");
      this.fail(error);
      throw new AppFailure(error);
    }
    try {
      const result = await this.transport.request(
        {
          threadId: this.snapshot.threadId,
          method: "set_todos",
          params: { phases: cloneValue(phases) as TodoPhase[] },
        },
        options,
      );
      const rawResult = result as unknown;
      if (!isRecord(rawResult) || !Array.isArray(rawResult.todoPhases)) {
        throw new AppFailure({
          code: "internal",
          message: "omp returned an invalid todo state",
          retryable: false,
        });
      }
      const todoPhases = rawResult.todoPhases as TodoPhase[];
      const next = mutableSnapshot(this.snapshot);
      updateTodos(next, todoPhases);
      next.error = null;
      this.commit(next);
      return cloneValue(todoPhases);
    } catch (error) {
      const appError = appErrorFromUnknown(error, "Setting todos failed");
      this.fail(appError);
      throw error;
    }
  }

  /**
   * Answers one of the host's dialogs in the host's shape for its method. A failed answer is thrown to the caller; this
   * store keeps the dialog pending until the transport accepts the answer. The dialog host keeps `invalid_args` and
   * `omp_exited` questions open for retry, but closes to the default result on `not_found`. None of these failures are
   * written to the thread's banner.
   */
  public async answerDialog(
    id: string,
    answer: HostDialogAnswer,
    options?: PortCallOptions,
  ): Promise<void> {
    if (!this.transport.answer) {
      const error = errorForUnavailable("answer");
      this.fail(error);
      throw new AppFailure(error);
    }
    await this.transport.answer({ threadId: this.snapshot.threadId, id, answer }, options);
    const next = mutableSnapshot(this.snapshot);
    const pending = copyPending(next);
    delete pending.dialogs[id];
    setPending(next, pending);
    this.commit(next);
  }

  /**
   * Answers a call of one of the app's tools with omp's tool result. The call stays pending until the transport accepts
   * the answer; a failed answer is thrown to the caller and shown on the thread's banner.
   */
  public async answerHostTool(
    id: string,
    answer: ToolCallAnswer,
    options?: PortCallOptions,
  ): Promise<void> {
    await this.answerHostCall(
      "hostTools",
      id,
      answer,
      "Answering the host tool request failed",
      options,
    );
  }

  /** Answers a read or write of one of the app's URI schemes with omp's URI result. */
  public async answerHostUri(
    id: string,
    answer: UriReadAnswer | UriWriteAnswer,
    options?: PortCallOptions,
  ): Promise<void> {
    await this.answerHostCall(
      "hostUris",
      id,
      answer,
      "Answering the host URI request failed",
      options,
    );
  }

  /** Sends a running tool call's progress; the call stays pending. Answers whether the call was still running. */
  public async updateHostTool(
    id: string,
    partialResult: HostToolUpdateParams["partialResult"],
    options?: PortCallOptions,
  ): Promise<boolean> {
    if (!this.transport.updateHostTool) {
      const error = errorForUnavailable("updateHostTool");
      this.fail(error);
      throw new AppFailure(error);
    }
    try {
      const { delivered } = await this.transport.updateHostTool(
        { threadId: this.snapshot.threadId, params: { callId: id, partialResult } },
        options,
      );
      return delivered;
    } catch (error) {
      this.fail(appErrorFromUnknown(error, "Sending the host tool's progress failed"));
      throw error;
    }
  }

  private async answerHostCall(
    kind: "hostTools" | "hostUris",
    id: string,
    answer: unknown,
    failure: string,
    options?: PortCallOptions,
  ): Promise<void> {
    if (!this.transport.answer) {
      const error = errorForUnavailable("answer");
      this.fail(error);
      throw new AppFailure(error);
    }
    try {
      await this.transport.answer({ threadId: this.snapshot.threadId, id, answer }, options);
      const next = mutableSnapshot(this.snapshot);
      const pending = copyPending(next);
      delete pending[kind][id];
      setPending(next, pending);
      this.commit(next);
    } catch (error) {
      this.fail(appErrorFromUnknown(error, failure));
      throw error;
    }
  }

  /**
   * Admits a finished live-voice turn into the transcript as an ordinary message. omp keeps a voice turn only as live
   * frames, so the text is recorded here under a stable id: the same session, role and turn replaces its earlier
   * admission (a later final frame for that turn), and nothing else in the transcript is touched.
   */
  public admitVoiceTurn(turn: VoiceTurn): void {
    const id = `voice:${turn.sessionId}:${turn.role}:${turn.turn}` as OmpStreamMessageId;
    const key = provisionalMessageKey(this.snapshot.processId, id);
    const message = {
      role: turn.role,
      content: [{ type: "text", text: turn.text }],
      timestamp: Date.now(),
    } as unknown as OmpMessage;
    const next = mutableSnapshot(this.snapshot);
    const isNew = next.messages[key] === undefined;
    addOrReplaceMessage(next, key, { key, message, status: "ended", streamMessageId: id });
    if (isNew) this.order = spliced(this.order, this.order.length, 0, key);
    this.commit(next);
  }

  /**
   * Records that the person sent a prompt from this chat, from the moment the send starts. The chat is no longer empty then,
   * not when omp's echo of the prompt reaches the transcript, so the composer moves to the bottom at Enter. A plain new
   * prompt (`shown`) also gets its row now, with its text and images: omp's echo takes that row's place. Returns the row's
   * key, which `unmarkPromptSent` takes back for a send that omp refuses.
   */
  public markPromptSent(shown?: PendingPromptIntent): MessageKey | undefined {
    const next = mutableSnapshot(this.snapshot);
    updatePrompt(next, { sent: true });
    const key = shown === undefined ? undefined : this.addPendingPrompt(next, shown);
    this.commit(next);
    return key;
  }

  /**
   * Undoes `markPromptSent` for a send that omp refused before admitting it: the send's row goes, and the chat is empty
   * again when no message is in it.
   */
  public unmarkPromptSent(pendingKey?: MessageKey): void {
    const next = mutableSnapshot(this.snapshot);
    if (
      pendingKey !== undefined &&
      next.pendingPrompts.some((pending) => pending.key === pendingKey)
    ) {
      removePendingPrompts(next, [pendingKey]);
    }
    if (this.order.length === 0 && next.pendingPrompts.length === 0) {
      updatePrompt(next, { sent: false });
    }
    this.commit(next);
  }

  /**
   * Adds the row of a plain prompt the person sent: its text and images, with no timestamp (omp's echo carries its own, and a
   * row that waits must not pair with a copy by it: `streamedCopyKey`). The row is drawn after the chat's messages, but it is
   * not in `messageOrder` until omp's echo takes its place, so the chat's readers see no message until then. Nothing is added
   * for an empty prompt.
   */
  private addPendingPrompt(
    next: MutableSnapshot,
    shown: PendingPromptIntent,
  ): MessageKey | undefined {
    const images = shown.images ?? [];
    if (shown.text.length === 0 && images.length === 0) return undefined;
    const content = [
      ...(shown.text.length === 0 ? [] : [{ type: "text", text: shown.text }]),
      ...images.map((image) => cloneValue(image)),
    ];
    const key = provisionalMessageKey(
      next.processId,
      `pending-prompt-${this.generatedMessageNumber++}` as OmpStreamMessageId,
    );
    const message = { role: "user", content } as unknown as OmpMessage;
    addOrReplaceMessage(next, key, { key, message, status: "pending" });
    next.pendingPrompts = [...next.pendingPrompts, { key, afterSeq: next.lastSeq }];
    return key;
  }

  /**
   * Shows a dialog the chat's host still waits on, when its chat is opened again (the port's `openRequests`). The
   * replay cannot say which dialogs were answered, so the server's record of the open ones is recorded here; a tool or
   * URI call is not a dialog and is left out. It does not move the sequence: the dialog's event was replayed before, or
   * is still to come.
   */
  public recordOpenQuestion(request: HostRequest, seq: number): void {
    if (!isHostDialogRequest(request)) return;
    if (this.snapshot.pending.dialogs[request.id] !== undefined) return;
    const next = mutableSnapshot(this.snapshot);
    const pending = copyPending(next);
    pending.dialogs[request.id] = { request: cloneValue(request), receivedSeq: seq };
    setPending(next, pending);
    this.commit(next);
  }

  /**
   * Shows a status, widget or title the chat's host holds when the chat is opened again (the port's `uiState`). Like
   * `recordOpenQuestion`, it does not move the sequence: the event was replayed before, or is still to come.
   */
  public recordState(event: UiStateEvent, seq: number): void {
    this.forwardNotification(event, seq, true);
  }

  private fail(error: AppError): void {
    const next = mutableSnapshot(this.snapshot);
    setError(next, error);
    this.commit(next);
  }

  /**
   * Publishes the event's draft. Unchanged branches are shared with the previous snapshot and changed ones are frozen (Immer
   * auto-freeze). The order is set here, so a change to it makes a new snapshot. A commit that changes neither publishes
   * nothing: the snapshot and its listeners stay as they were.
   */
  private commit(next: MutableSnapshot): void {
    const draft = next as unknown as Draft<Omit<RuntimeSnapshot, "messageOrder">>;
    const base = original(draft);
    const finished = finishDraft(draft);
    if (finished === base && this.order === this.snapshot.messageOrder) return;
    this.snapshot = Object.freeze({
      ...finished,
      messageOrder: this.order,
      revision: this.snapshot.revision + 1,
    });
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private reduceProcess(
    next: MutableSnapshot,
    status: ProcessState["status"],
    error?: AppError,
    startedAt?: number,
  ): void {
    const previousStatus = this.snapshot.process.status;
    const startsNewProcess =
      (status === "starting" || status === "ready") &&
      (previousStatus === "exited" || previousStatus === "stopped" || previousStatus === "error");
    if (startsNewProcess) {
      next.processGeneration += 1;
      next.processId = processIdForGeneration(next.threadId, next.processGeneration);
      this.interruptStreamingMessages(next);
      this.streamKeys.clear();
    }
    setProcess(next, status, error, startedAt);
    // A process that stopped, exited or failed answers nothing more: a prompt it was given will never be echoed.
    if (status === "stopped" || status === "exited" || status === "error") {
      removePendingPrompts(next, pendingKeysOf(next));
    }
    if (status === "exited") {
      this.interruptStreamingMessages(next);
      this.streamKeys.clear();
      cancelActiveTools(next);
      updatePrompt(next, { streaming: false });
      dropDialogs(next);
    }
  }

  private interruptStreamingMessages(next: MutableSnapshot): void {
    const streaming = next.streaming as Record<string, RuntimeMessage>;
    const pending = next.pendingEnded as ProvisionalMessageKey[];
    // The open streamed copies are read from the published snapshot: a draft's children must never end up inside a record.
    for (const [key, message] of Object.entries(this.snapshot.streaming)) {
      if (!key.startsWith("stream:") || message.status !== "streaming") continue;
      const provisionalKey = key as ProvisionalMessageKey;
      const interrupted: RuntimeMessage = { ...message, status: "ended", interrupted: true };
      next.messages = recordWith(next.messages, provisionalKey, interrupted);
      delete streaming[key];
      if (!pending.includes(provisionalKey)) pending.push(provisionalKey);
    }
    updatePrompt(next, { streaming: false });
  }

  private forwardNotification(rawFrame: unknown, seq: number, replayed: boolean): void {
    if (!isRecord(rawFrame) || typeof rawFrame.type !== "string") return;
    const frame = rawFrame as unknown as RuntimeNotificationFrame;
    let heard = false;
    for (const subscription of this.notificationSubscriptions) {
      if (subscription.types.has(rawFrame.type)) {
        heard = true;
        subscription.listener(frame, seq, replayed);
      }
    }
    if (!heard && isPresentationFrame(rawFrame)) {
      keepUndelivered(this.undeliveredFrames, { type: rawFrame.type, frame, seq, replayed });
    }
  }

  private forwardOmpEvent(event: OmpEvent, seq: number, replayed: boolean): void {
    let heard = false;
    for (const subscription of this.ompEventSubscriptions) {
      if (subscription.types === undefined || subscription.types.has(event.type)) {
        heard = true;
        subscription.listener(event, seq, replayed);
      }
    }
    if (!heard) keepUndelivered(this.undeliveredEvents, { event, seq, replayed });
  }

  /**
   * A `!` command's `running` and `ended` events (`BashCommandPayload`). A command is a row from its `running` event; its
   * `ended` event keeps that row with omp's answer, until the transcript entry omp writes for the command takes its place
   * (`settleEndedCommands`). An `ended` a viewer replays from before it subscribed only drops its running row: the history
   * holds the entry by then. An `ended` whose entry the transcript already holds adds no row of its own.
   */
  private reduceBashCommand(
    next: MutableSnapshot,
    rawEvent: Record<string, unknown>,
    seq: number,
    replayed: boolean,
  ): void {
    const { command, status, startedAt } = rawEvent;
    if (typeof command !== "string" || typeof startedAt !== "number") return;
    if (status === "running") {
      next.commands = [...next.commands, { seq, startedAt, command, phase: "running" }];
      return;
    }
    const result = bashResultOf(rawEvent.result);
    const index = next.commands.findIndex(
      (entry) => entry.phase === "running" && entry.command === command,
    );
    const current = index === -1 ? undefined : next.commands[index];
    if (replayed || isPersistedCommand(next, command, result, startedAt)) {
      if (index !== -1) next.commands = next.commands.filter((_, at) => at !== index);
      return;
    }
    const ended: BashCommandState = {
      seq: current?.seq ?? seq,
      startedAt,
      command,
      phase: "ended",
      ...(result === undefined ? {} : { result }),
    };
    next.commands =
      current === undefined
        ? [...next.commands, ended]
        : next.commands.map((entry, at) => (at === index ? ended : entry));
  }

  private reducePromptResult(next: MutableSnapshot, rawEvent: unknown): void {
    if (!isRecord(rawEvent) || rawEvent.type !== "prompt_result") return;
    if (typeof rawEvent.agentInvoked !== "boolean") return;
    if (
      rawEvent.status !== "completed" &&
      rawEvent.status !== "aborted" &&
      rawEvent.status !== "error"
    )
      return;
    if (typeof rawEvent.sessionSettled !== "boolean") return;
    // omp reports a prompt once its work has settled, and an admitted prompt is echoed before that. A row still waiting here
    // is a prompt omp dropped or failed (rpc-prompt-results.ts settle()), so its row goes.
    removePendingPrompts(next, pendingKeysOf(next));
    const result: PromptResultState = {
      type: "prompt_result",
      agentInvoked: rawEvent.agentInvoked,
      status: rawEvent.status,
      sessionSettled: rawEvent.sessionSettled,
      id: asString(rawEvent.requestId),
      error: isRecord(rawEvent.error)
        ? (cloneValue(rawEvent.error) as unknown as Omp.PromptError)
        : undefined,
    };
    updatePrompt(next, { admitted: true, streaming: false, promptResult: result });
    if (result.status === "aborted" || result.status === "error") {
      cancelActiveTools(next);
    }
    if (result.status === "error") {
      const detail = result.error;
      setError(next, {
        code: "omp_error",
        message: detail?.message ?? "omp prompt failed",
        retryable: detail?.retryable ?? false,
        omp: detail
          ? {
              error: detail.message,
              provider: detail.provider,
              model: detail.model,
              httpStatus: detail.httpStatus,
            }
          : undefined,
      });
    }
  }

  private reduceNotification(next: MutableSnapshot, rawFrame: unknown, seq: number): void {
    if (!isRecord(rawFrame) || typeof rawFrame.type !== "string") return;
    const frame = rawFrame as Record<string, unknown>;
    const pending = copyPending(next);
    switch (frame.type) {
      case "host_dialog": {
        const request = (frame as unknown as HostDialogFrame).request;
        if (!isRecord(request) || !isHostDialogRequest(request as HostRequest)) return;
        pending.dialogs[request.id] = { request: cloneValue(request), receivedSeq: seq };
        setPending(next, pending);
        return;
      }
      case "host_dialog_cancel": {
        const requestId = asString(frame.requestId);
        if (requestId) delete pending.dialogs[requestId];
        setPending(next, pending);
        return;
      }
      case "host_call": {
        const request = (frame as unknown as HostCallFrame).request;
        if (!isRecord(request)) return;
        if (isHostToolCall(request as HostRequest)) {
          pending.hostTools[request.id] = {
            request: cloneValue(request) as HostToolCall,
            receivedSeq: seq,
          };
        } else if (isHostUriCall(request as HostRequest)) {
          pending.hostUris[request.id] = {
            request: cloneValue(request) as HostUriCall,
            receivedSeq: seq,
          };
        } else return;
        setPending(next, pending);
        return;
      }
      case "host_call_cancel": {
        // omp gave a call up (`tool_cancel`, `uri_cancel`): its answer would reach nothing.
        const requestId = asString(frame.requestId);
        if (requestId) {
          delete pending.hostTools[requestId];
          delete pending.hostUris[requestId];
        }
        setPending(next, pending);
        return;
      }
      case "extension_error":
        if (typeof frame.error === "string") {
          setError(next, {
            code: "omp_error",
            message: frame.error,
            retryable: false,
            heading: EXTENSION_ERROR_HEADING,
            extension: extensionNameOf(frame.extensionPath),
          });
        }
        return;
      case "goal_updated":
        reduceGoalUpdated(next, frame);
        return;
      default:
        // Notifications are open to newer omp types. Unknown types are not state errors.
        return;
    }
  }

  private reduceOmp(next: MutableSnapshot, rawEvent: unknown, seq: number): void {
    if (!isRecord(rawEvent) || typeof rawEvent.type !== "string") return;
    const event = rawEvent as OmpEvent & Record<string, unknown>;
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        // A run that starts is new work: an error omp reported for earlier work no longer describes
        // the conversation.
        if (event.type === "agent_start") clearEarlierOmpError(next);
        updatePrompt(next, {
          admitted: true,
          streaming: true,
          promptResult: null,
          sessionSettled: false,
        });
        return;
      case "agent_end":
        // The turn ended with no echo for a prompt still waiting as a row: omp will not echo it (see `reduceMessageStart`).
        removePendingPrompts(next, pendingKeysOf(next));
        updatePrompt(next, { streaming: false });
        return;
      case "turn_end":
        // A turn ending is not the run ending: omp's own isStreaming stays true until agent_end, so the composer
        // still sees a run between two turns and sends a follow-up or a steer, never a new prompt omp would refuse.
        return;
      case "message_start":
        this.reduceMessageStart(next, event, seq);
        return;
      case "message_update":
        this.reduceMessageUpdate(next, event, seq);
        return;
      case "message_end":
        this.reduceMessageEnd(next, event, seq);
        return;
      case "tool_execution_start":
        this.reduceToolStart(next, event);
        return;
      case "tool_execution_update":
        this.reduceToolUpdate(next, event, false);
        return;
      case "tool_stream_update":
        this.reduceToolUpdate(next, event, true);
        return;
      case "tool_execution_end":
        this.reduceToolEnd(next, event);
        return;
      // omp's RPC session sent goal updates as omp events, and the store read them only as notification frames, so a
      // goal created, paused or finished during a run never reached the goal until a state read (found in H5.4a).
      case "goal_updated":
        reduceGoalUpdated(next, event);
        return;
      case "queue_update":
        if (Array.isArray(event.steering) && Array.isArray(event.followUp)) {
          updateQueues(next, {
            steering: event.steering.filter((item): item is string => typeof item === "string"),
            followUp: event.followUp.filter((item): item is string => typeof item === "string"),
            liveSteered: liveSteeredOf(event),
          });
        }
        return;
      case "todo_reminder": {
        // A reminder lists only the unfinished tasks when a turn stops. It is a transcript panel and never replaces the
        // todo state (omp v18.12.6: sent by src/session/todo-tracker.ts:285-305, shown as a panel by
        // src/modes/controllers/event-controller.ts:2762-2765).
        if (!Array.isArray(event.todos)) return;
        const reminder: TodoReminderState = {
          todos: cloneValue(event.todos) as TodoItem[],
          attempt: typeof event.attempt === "number" ? event.attempt : 1,
          maxAttempts: typeof event.maxAttempts === "number" ? event.maxAttempts : 1,
          afterMessage: reminderRowId(next, this.order),
        };
        next.todoReminders = [...next.todoReminders, reminder].slice(-MAX_TODO_REMINDERS);
        return;
      }
      case "todo_auto_clear":
        updateTodos(next, []);
        return;
      case "notice":
        if (event.level === "error" && typeof event.message === "string") {
          setError(next, {
            code: "omp_error",
            message: event.message,
            retryable: true,
            heading: NOTICE_ERROR_HEADING,
            source: typeof event.source === "string" ? event.source : undefined,
          });
        }
        return;
      default:
        // The session event union is expected to grow. State must remain safe for unknown events.
        return;
    }
  }

  private reduceMessageStart(
    next: MutableSnapshot,
    event: Record<string, unknown>,
    seq: number,
  ): void {
    if (!isRecord(event.message)) return;
    const message = cloneValue(event.message) as unknown as OmpMessage;
    const messageId = messageIdForEvent(event, seq, this.generatedMessageNumber++);
    const key = provisionalMessageKey(this.snapshot.processId, messageId);
    this.streamKeys.set(messageId, key);
    const order = this.order;
    // The pending row this echo answers: the oldest one added before the echo's seq (`markPromptSent`). Only the person's own
    // user message is an echo: omp marks an agent's or a synthetic one (`attribution`, `synthetic`), which they did not type.
    const echoedKey =
      message.role === "user" && message.attribution !== "agent" && message.synthetic !== true
        ? next.pendingPrompts.find((pending) => seq > pending.afterSeq)?.key
        : undefined;
    // A message the history already shows (the stream was replayed, or lagged behind a history load) takes that message's
    // place instead of showing twice. The copy keeps that row's id, so a notice that follows the row still follows it
    // (issue 1522). The pending row of such an echo is a duplicate, and goes.
    if (
      echoedKey !== undefined &&
      shownCopyIndex(next, this.historyCopies, order, key, message) >= 0
    ) {
      removePendingPrompts(next, [echoedKey]);
    }
    const shownIndex = shownCopyIndex(next, this.historyCopies, order, key, message);
    const shownKey = shownIndex >= 0 ? order[shownIndex] : undefined;
    const shown = shownKey === undefined ? undefined : next.messages[shownKey];
    // Otherwise the echo takes the pending row's place: its row id is kept, so the element is not replaced, and the echo
    // joins the chat as its newest message.
    const replacedKey = shown === undefined ? echoedKey : undefined;
    const rowKey = shown === undefined ? replacedKey : rowIdOf(shown);
    const record: RuntimeMessage = {
      key,
      message,
      status: "streaming",
      streamMessageId: messageId,
      ...(rowKey === undefined ? {} : { rowKey }),
    };
    // A message the store already holds is in the order: its start put it there, so only a new one is added.
    const isNew = next.messages[key] === undefined;
    if (replacedKey !== undefined) removePendingPrompts(next, [replacedKey]);
    addOrReplaceMessage(next, key, record);
    if (isNew) {
      this.order =
        shownIndex >= 0 ? spliced(order, shownIndex, 1, key) : spliced(order, order.length, 0, key);
    }
    updatePrompt(next, { admitted: true, streaming: true, sessionSettled: false });
  }

  private keyForStream(
    event: Record<string, unknown>,
    seq: number,
  ): { key: ProvisionalMessageKey; id: OmpStreamMessageId } {
    const explicit = asString(event.messageId);
    if (explicit) {
      const existing = this.streamKeys.get(explicit);
      if (existing) return { key: existing, id: explicit as OmpStreamMessageId };
      const id = explicit as OmpStreamMessageId;
      const key = provisionalMessageKey(this.snapshot.processId, id);
      this.streamKeys.set(explicit, key);
      return { key, id };
    }
    const active = [...this.streamKeys.values()].find(
      (key) => this.snapshot.messages[key]?.status === "streaming",
    );
    if (active)
      return { key: active, id: active.slice(active.lastIndexOf(":") + 1) as OmpStreamMessageId };
    const id = messageIdForEvent(event, seq, this.generatedMessageNumber++);
    const key = provisionalMessageKey(this.snapshot.processId, id);
    this.streamKeys.set(id, key);
    return { key, id };
  }

  private reduceMessageUpdate(
    next: MutableSnapshot,
    event: Record<string, unknown>,
    seq: number,
  ): void {
    if (!isRecord(event.message)) return;
    const { key, id } = this.keyForStream(event, seq);
    const previous = pendingMessageForKey(next, key);
    const candidate = cloneValue(event.message) as unknown as OmpMessage;
    const assistantEvent = event.assistantMessageEvent as Omp.AssistantMessageEvent | undefined;
    const message =
      assistantEvent && isAssistantMessage(candidate)
        ? copyAssistantWithDelta(
            previous && isAssistantMessage(previous.message) ? previous.message : undefined,
            candidate,
            assistantEvent,
          )
        : candidate;
    const record: RuntimeMessage = {
      key,
      message,
      status: "streaming",
      streamMessageId: id,
      ...keptRowKey(next, key),
    };
    addOrReplaceMessage(next, key, record);
    // A message's first event adds it to the order (its start normally did); a message the store holds is in the order already.
    if (previous === undefined) this.order = spliced(this.order, this.order.length, 0, key);
    updatePrompt(next, { admitted: true, streaming: true, sessionSettled: false });
  }

  private reduceMessageEnd(
    next: MutableSnapshot,
    event: Record<string, unknown>,
    seq: number,
  ): void {
    if (!isRecord(event.message)) return;
    const { key, id } = this.keyForStream(event, seq);
    const record: RuntimeMessage = {
      key,
      message: cloneValue(event.message) as unknown as OmpMessage,
      status: "ended",
      streamMessageId: id,
      ...keptRowKey(next, key),
    };
    const isNew = pendingMessageForKey(next, key) === undefined;
    addOrReplaceMessage(next, key, record);
    if (isNew) this.order = spliced(this.order, this.order.length, 0, key);
    if (!(next.pendingEnded as ProvisionalMessageKey[]).includes(key)) {
      (next.pendingEnded as ProvisionalMessageKey[]).push(key);
    }
    updatePrompt(next, { admitted: true });
  }

  private reduceToolStart(next: MutableSnapshot, event: Record<string, unknown>): void {
    const toolCallId = asToolCallId(event.toolCallId);
    const toolName = asString(event.toolName);
    if (!toolCallId || !toolName) return;
    const previous = next.tools[toolCallId];
    next.tools = recordWith(next.tools, toolCallId, {
      toolCallId,
      toolName,
      args: cloneValue(event.args),
      intent: asString(event.intent),
      status: "running",
      // Argument projections stream in before execution starts; keep the latest one.
      streamProjection: previous?.streamProjection,
    });
  }

  private reduceToolUpdate(
    next: MutableSnapshot,
    event: Record<string, unknown>,
    stream: boolean,
  ): void {
    const toolCallId = asToolCallId(event.toolCallId);
    const toolName = asString(event.toolName);
    if (!toolCallId || !toolName) return;
    const previous = next.tools[toolCallId];
    next.tools = recordWith(next.tools, toolCallId, {
      toolCallId,
      toolName,
      args: event.args === undefined ? previous?.args : cloneValue(event.args),
      intent: previous?.intent,
      // A late update (a worker reports after its call returned) adds progress; it leaves an ended call's state alone.
      status:
        previous !== undefined && ENDED_TOOL_STATUSES[previous.status] === true
          ? previous.status
          : "partial",
      partialResult: stream ? previous?.partialResult : cloneValue(event.partialResult),
      streamProjection: stream ? cloneValue(event.update) : previous?.streamProjection,
      result: previous?.result,
      isError: previous?.isError,
    });
  }

  private reduceToolEnd(next: MutableSnapshot, event: Record<string, unknown>): void {
    const toolCallId = asToolCallId(event.toolCallId);
    const toolName = asString(event.toolName);
    if (!toolCallId || !toolName) return;
    const isError = event.isError === true;
    const previous = next.tools[toolCallId];
    next.tools = recordWith(next.tools, toolCallId, {
      toolCallId,
      toolName,
      args: event.args === undefined ? previous?.args : cloneValue(event.args),
      intent: previous?.intent,
      status: isError ? "error" : "success",
      partialResult: previous?.partialResult,
      streamProjection: previous?.streamProjection,
      result: cloneValue(event.result),
      isError,
    });
    // omp derives its todo list from every successful `todo` result except `view`
    // (src/tools/todo.ts:194-199 at v18.12.6); the app follows the same rule.
    const phases = todoPhasesFromResult(toolName, isError, event.result);
    if (phases) updateTodos(next, phases);
  }

  private pairEndedInDraft(next: MutableSnapshot, entries: readonly unknown[]): void {
    const waitingKeys = [...next.pendingEnded];
    if (waitingKeys.length === 0) return;
    const candidates = entries.filter((value) => {
      const entry = entryFromUnknown(value);
      if (!entry) return false;
      const current = next.transcript.entries[entry.id];
      if (current?.messageKey === undefined) return true;
      // An entry shown from history (no live message behind it yet) still takes its live message,
      // so a message omp streams and also returns from get_entries appears once.
      return next.messages[current.messageKey]?.streamMessageId === undefined;
    });
    if (candidates.length === 0) return;
    const messages = waitingKeys
      .map((key) => next.messages[key]?.message)
      .filter((message): message is OmpMessage => message !== undefined);
    const ids = pairEndedOmpMessages(messages, candidates);
    const pending = next.pendingEnded as ProvisionalMessageKey[];
    let messageIndex = 0;
    for (const key of waitingKeys) {
      const message = next.messages[key];
      if (!message) continue;
      const pairedId = ids[messageIndex];
      messageIndex += 1;
      if (!pairedId) continue;
      const entry = next.transcript.entries[pairedId];
      const persistedKey = persistedMessageKey(next.threadId, pairedId);
      const persisted: RuntimeMessage = {
        ...message,
        key: persistedKey,
        status: "persisted",
        entryId: pairedId,
        parentId: entry?.parentId,
        rowKey: message.rowKey ?? key,
      };
      addOrReplaceMessage(next, persistedKey, persisted);
      removeMessage(next, key);
      this.order = replacedInOrder(this.order, key, persistedKey);
      mergeEntryMessageKey(next, pairedId, persistedKey);
      const pendingIndex = pending.indexOf(key);
      if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
      this.streamKeys.delete(message.streamMessageId ?? "");
    }
  }
}

export type { OmpMessage, TodoItem, TodoPhase };
