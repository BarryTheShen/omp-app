import type {
  AppError,
  EntryId,
  ExtensionUiResponse,
  HostToolResponse,
  HostUriResponse,
  MessageKey,
  OmpEvent,
  OmpMessage,
  OmpProcessId,
  OmpStreamMessageId,
  OmpWire,
  PortCallOptions,
  ProvisionalMessageKey,
  RpcSessionClient,
  RpcSessionEvent,
  RpcSessionNotification,
  RpcSessionSend,
  ThreadId,
  ToolCallId,
} from "@omp-app/contracts";
import {
  AppFailure,
  pairEndedMessages as pairEndedOmpMessages,
  persistedMessageKey,
  provisionalMessageKey,
} from "@omp-app/contracts";
import { createDraft, type Draft, finishDraft } from "immer";

type QueueMode = OmpWire.QueueMode;
type SessionState = OmpWire.SessionState;
type TodoItem = OmpWire.TodoItem;
type TodoPhase = OmpWire.TodoPhase;

/** A mutable Immer draft is never exposed; `commit` finishes it into a frozen snapshot that shares every unchanged branch with the previous one. */
type MutableSnapshot = {
  -readonly [Key in keyof RuntimeSnapshot]: RuntimeSnapshot[Key];
};

/** The lifecycle of a message received from omp's event stream. */
export type RuntimeMessageStatus = "streaming" | "ended" | "persisted";

export interface RuntimeMessage {
  readonly key: MessageKey;
  readonly message: OmpMessage;
  readonly status: RuntimeMessageStatus;
  readonly streamMessageId?: OmpStreamMessageId;
  readonly entryId?: EntryId;
  readonly parentId?: EntryId | null;
  readonly interrupted?: boolean;
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
  readonly status: OmpWire.PromptStatus;
  readonly sessionSettled: boolean;
  readonly id?: string;
  readonly error?: OmpWire.PromptError;
}

/** Prompt completion and session settlement are deliberately separate signals. */
export interface PromptLifecycleState {
  readonly admitted: boolean;
  readonly streaming: boolean;
  readonly promptResult: PromptResultState | null;
  readonly sessionSettled: boolean;
  readonly promptResults: readonly PromptResultState[];
}

export interface QueueState {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly steeringMode: QueueMode;
  readonly followUpMode: QueueMode;
  readonly interruptMode: OmpWire.InterruptMode;
}

export interface PendingExtensionUiRequest {
  readonly request: OmpWire.ExtensionUiRequest;
  readonly receivedSeq: number;
}

export interface PendingHostToolRequest {
  readonly request: OmpWire.HostToolCallRequest;
  readonly receivedSeq: number;
}

export interface PendingHostUriRequest {
  readonly request: OmpWire.HostUriRequest;
  readonly receivedSeq: number;
}

export interface PendingRequestsState {
  readonly extensionUi: Readonly<Record<string, PendingExtensionUiRequest>>;
  readonly hostTools: Readonly<Record<string, PendingHostToolRequest>>;
  readonly hostUris: Readonly<Record<string, PendingHostUriRequest>>;
}

export interface ProcessState {
  readonly status: "starting" | "ready" | "running" | "stopped" | "restarting" | "exited" | "error";
  readonly error: AppError | null;
}

/** omp's `todo_reminder`: the unfinished tasks when a turn stops, shown as a transcript panel (not todo state). */
export interface TodoReminderState {
  readonly todos: readonly TodoItem[];
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The message the panel follows in the transcript; null when the transcript was empty. */
  readonly afterMessage: MessageKey | null;
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
  readonly tools: Readonly<Record<ToolCallId, ToolCallState>>;
  readonly prompt: PromptLifecycleState;
  readonly queue: QueueState;
  readonly todoPhases: readonly TodoPhase[];
  /** `todo_reminder` panels in arrival order, newest last, at most 20. */
  readonly todoReminders: readonly TodoReminderState[];
  readonly pending: PendingRequestsState;
  readonly process: ProcessState;
  readonly error: AppError | null;
}

export type RuntimeStoreListener = (snapshot: RuntimeSnapshot) => void;
export type RuntimeNotificationFrame = RpcSessionNotification;
export type RuntimeNotificationListener = (frame: RuntimeNotificationFrame, seq: number) => void;

interface NotificationSubscription {
  readonly types: ReadonlySet<string>;
  readonly listener: RuntimeNotificationListener;
}

/** The A0 methods needed by this store; all other runtime actions belong to later R0 parts. */
export interface OmpRuntimeTransport {
  readonly send?: RpcSessionSend;
  readonly answerExtensionUi?: RpcSessionClient["answerExtensionUi"];
  readonly answerHostTool?: RpcSessionClient["answerHostTool"];
  readonly answerHostUri?: RpcSessionClient["answerHostUri"];
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
});
const EMPTY_PENDING: PendingRequestsState = Object.freeze({
  extensionUi: Object.freeze({}),
  hostTools: Object.freeze({}),
  hostUris: Object.freeze({}),
});
const EMPTY_PROCESS: ProcessState = Object.freeze({ status: "starting", error: null });
const PROCESS_STATUSES: Record<ProcessState["status"], true> = {
  starting: true,
  ready: true,
  running: true,
  stopped: true,
  restarting: true,
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

function isAssistantMessage(message: OmpMessage): message is OmpWire.AssistantMessage {
  return message.role === "assistant";
}

function copyAssistantWithDelta(
  previous: OmpWire.AssistantMessage | undefined,
  candidate: OmpWire.AssistantMessage,
  update: OmpWire.AssistantMessageEvent,
): OmpWire.AssistantMessage {
  const deltaEvent = update as { type: string; contentIndex?: number; delta?: unknown };
  if (
    (deltaEvent.type !== "text_delta" &&
      deltaEvent.type !== "thinking_delta" &&
      deltaEvent.type !== "toolcall_delta") ||
    typeof deltaEvent.delta !== "string" ||
    typeof deltaEvent.contentIndex !== "number"
  ) {
    return cloneValue(candidate);
  }

  const index = deltaEvent.contentIndex;
  const delta = deltaEvent.delta;
  const content = candidate.content.map((part) => cloneValue(part));
  const previousContent = previous?.content ?? [];
  const previousPart = previousContent[index];
  const candidatePart = content[index];
  if (!candidatePart) return cloneValue(candidate);

  if (deltaEvent.type === "text_delta" || deltaEvent.type === "thinking_delta") {
    const field = deltaEvent.type === "text_delta" ? "text" : "thinking";
    if (
      !isRecord(candidatePart) ||
      candidatePart.type !== field ||
      typeof candidatePart[field] !== "string"
    ) {
      return cloneValue(candidate);
    }
    const candidateText = candidatePart[field] as string;
    const previousText =
      isRecord(previousPart) &&
      previousPart.type === field &&
      typeof previousPart[field] === "string"
        ? (previousPart[field] as string)
        : "";
    if (candidateText === previousText || candidateText.length < previousText.length) {
      candidatePart[field] = `${previousText}${delta}`;
    } else if (
      !candidateText.endsWith(delta) &&
      !candidateText.startsWith(`${previousText}${delta}`)
    ) {
      candidatePart[field] = `${candidateText}${delta}`;
    }
  } else if (isRecord(candidatePart) && candidatePart.type === "toolCall") {
    const rawBlock = typeof candidatePart.rawBlock === "string" ? candidatePart.rawBlock : "";
    const previousRaw =
      isRecord(previousPart) &&
      previousPart.type === "toolCall" &&
      typeof previousPart.rawBlock === "string"
        ? previousPart.rawBlock
        : "";
    if (
      rawBlock === previousRaw ||
      (!rawBlock.endsWith(delta) && rawBlock.length <= previousRaw.length)
    ) {
      candidatePart.rawBlock = `${previousRaw}${delta}`;
    }
  }
  return { ...cloneValue(candidate), content };
}

function mutableSnapshot(snapshot: RuntimeSnapshot): MutableSnapshot {
  return createDraft(snapshot) as unknown as MutableSnapshot;
}

function makeInitialSnapshot(threadId: ThreadId): RuntimeSnapshot {
  const processGeneration = 0;
  return freezeDeep({
    threadId,
    processId: processIdForGeneration(threadId, processGeneration),
    processGeneration,
    revision: 0,
    lastSeq: 0,
    needsRefetch: false,
    transcript: { entries: {}, order: [], head: null },
    messages: {},
    streaming: {},
    messageOrder: [],
    pendingEnded: [],
    tools: {},
    prompt: EMPTY_PROMPT,
    queue: EMPTY_QUEUE,
    todoPhases: EMPTY_TODOS,
    todoReminders: EMPTY_REMINDERS,
    pending: EMPTY_PENDING,
    process: EMPTY_PROCESS,
    error: null,
  });
}

function pendingMessageForKey(
  snapshot: RuntimeSnapshot,
  key: ProvisionalMessageKey,
): RuntimeMessage | undefined {
  return snapshot.messages[key];
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
  const messages = next.messages as Record<string, RuntimeMessage>;
  const streaming = next.streaming as Record<string, RuntimeMessage>;
  messages[key] = value;
  if (value.status === "streaming" || value.status === "ended") {
    if (key.startsWith("stream:")) streaming[key] = value;
  } else {
    delete streaming[key];
  }
}

function removeMessage(next: MutableSnapshot, key: MessageKey): void {
  delete (next.messages as Record<string, RuntimeMessage>)[key];
  delete (next.streaming as Record<string, RuntimeMessage>)[key];
  const order = next.messageOrder as MessageKey[];
  const index = order.indexOf(key);
  if (index >= 0) order.splice(index, 1);
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
  };
  next.queue = nextQueue;
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

function setProcess(next: MutableSnapshot, status: ProcessState["status"], error?: AppError): void {
  const processError = error
    ? cloneValue(error)
    : status === "error" || status === "exited"
      ? errorForProcess(status)
      : null;
  next.process = { status, error: processError };
  if (processError) next.error = processError;
  else if (status === "ready" || status === "running" || status === "starting") next.error = null;
}

function cancelActiveTools(next: MutableSnapshot): void {
  const tools = next.tools as Record<string, ToolCallState>;
  for (const [toolCallId, tool] of Object.entries(tools)) {
    if (tool.status === "running" || tool.status === "partial") {
      tools[toolCallId] = { ...tool, status: "cancelled" };
    }
  }
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
  next.transcript = { entries, order, head: entry.id };
}
function mergeEntryMessageKey(next: MutableSnapshot, entryId: EntryId, key: MessageKey): void {
  const current = next.transcript.entries[entryId];
  if (!current) return;
  const entries = next.transcript.entries as Record<string, TranscriptEntry>;
  entries[entryId] = { ...current, messageKey: key };
}

interface PendingDraft {
  extensionUi: Record<string, PendingExtensionUiRequest>;
  hostTools: Record<string, PendingHostToolRequest>;
  hostUris: Record<string, PendingHostUriRequest>;
}

function copyPending(next: MutableSnapshot): PendingDraft {
  return {
    extensionUi: { ...next.pending.extensionUi },
    hostTools: { ...next.pending.hostTools },
    hostUris: { ...next.pending.hostUris },
  };
}

function setPending(next: MutableSnapshot, pending: PendingDraft): void {
  next.pending = pending;
}

function setError(next: MutableSnapshot, error: AppError): void {
  next.error = cloneValue(error);
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
  private readonly streamKeys = new Map<string, ProvisionalMessageKey>();
  private generatedMessageNumber = 0;

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
   * reducers of runtime state. The sequence gate in `ingest` provides ordering and de-duplication.
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
    return () => this.notificationSubscriptions.delete(subscription);
  }

  /**
   * Apply exactly one contiguous A0 envelope event. Replays are ignored. A gap is not applied: the
   * caller must refetch history and call `resetSequence` before the next event can change state.
   */
  public ingest(event: RpcSessionEvent, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new RangeError("event seq must be a positive safe integer");
    }
    if (seq <= this.snapshot.lastSeq || this.snapshot.needsRefetch) return;
    if (seq !== this.snapshot.lastSeq + 1) {
      const next = mutableSnapshot(this.snapshot);
      next.needsRefetch = true;
      this.commit(next);
      return;
    }

    const next = mutableSnapshot(this.snapshot);
    const eventValue = event as unknown as Record<string, unknown>;
    switch (eventValue.kind) {
      case "omp":
        this.reduceOmp(next, eventValue.event, seq);
        break;
      case "prompt_result":
        this.reducePromptResult(next, eventValue.event);
        break;
      case "session_settled":
        updatePrompt(next, { sessionSettled: true, streaming: false });
        cancelActiveTools(next);
        break;
      case "notification":
        this.reduceNotification(next, eventValue.frame, seq);
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
          );
        }
        break;
      }
      default:
        // A future RpcSessionEvent kind is intentionally ignored without losing the sequence slot.
        break;
    }
    next.lastSeq = seq;
    this.commit(next);
    if (eventValue.kind === "notification") {
      this.forwardNotification(eventValue.frame, seq);
    }
  }

  /** Clear a sequence gap after R0.2 has refetched state/history. */
  public resetSequence(lastSeq = 0): void {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      throw new RangeError("lastSeq must be a non-negative safe integer");
    }
    const next = mutableSnapshot(this.snapshot);
    next.lastSeq = lastSeq;
    next.needsRefetch = false;
    this.commit(next);
  }

  /** Set the contiguous cursor after a history replacement without changing the live state. */
  public markRefetched(lastSeq: number): void {
    this.resetSequence(lastSeq);
  }

  /** Add history entries and pair every waiting `message_end` by C0's identity rule. */
  public pairEndedMessages(entries: readonly unknown[], leafId?: EntryId | null): void {
    const next = mutableSnapshot(this.snapshot);
    const parsed = entriesFromUnknown(entries);
    for (const entry of parsed) recordTranscriptEntry(next, entry);
    if (leafId !== undefined) next.transcript = { ...next.transcript, head: leafId };
    this.pairEndedInDraft(next, entries);
    this.commit(next);
  }

  /** Add a tree projection from `get_tree`; history pagination belongs to R0.2. */
  public setTree(entries: readonly unknown[], leafId: EntryId | null): void {
    const next = mutableSnapshot(this.snapshot);
    const parsed = entriesFromUnknown(entries);
    for (const entry of parsed) recordTranscriptEntry(next, entry);
    next.transcript = { ...next.transcript, head: leafId };
    this.pairEndedInDraft(next, entries);
    this.commit(next);
  }

  /** Apply the relevant fields of a `get_state` result; no JSONL or wire parsing happens here. */
  public applySessionState(state: Partial<SessionState>): void {
    const next = mutableSnapshot(this.snapshot);
    updateQueues(next, {
      steering: state.queuedMessages?.steering,
      followUp: state.queuedMessages?.followUp,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      interruptMode: state.interruptMode,
    });
    if (state.todoPhases) updateTodos(next, state.todoPhases);
    updatePrompt(next, {
      admitted: state.isStreaming === true ? true : undefined,
      streaming: state.isStreaming,
      sessionSettled: state.isSettled,
    });
    this.commit(next);
  }

  /** Typed action used by U5; the server result remains authoritative. */
  public async setTodos(
    phases: readonly TodoPhase[],
    options?: PortCallOptions,
  ): Promise<readonly TodoPhase[]> {
    if (!this.transport.send) {
      const error = errorForUnavailable("setTodos");
      this.fail(error);
      throw new AppFailure(error);
    }
    try {
      const result = await this.transport.send(
        {
          threadId: this.snapshot.threadId,
          command: { type: "set_todos", phases: cloneValue(phases) as TodoPhase[] },
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

  /** Answer a pending extension UI request and remove it only after A0 accepts the answer. */
  public async answerExtensionUi(
    response: ExtensionUiResponse,
    options?: PortCallOptions,
  ): Promise<void> {
    if (!this.transport.answerExtensionUi) {
      const error = errorForUnavailable("answerExtensionUi");
      this.fail(error);
      throw new AppFailure(error);
    }
    try {
      await this.transport.answerExtensionUi(
        { threadId: this.snapshot.threadId, response },
        options,
      );
      const next = mutableSnapshot(this.snapshot);
      const pending = copyPending(next);
      delete pending.extensionUi[response.id];
      setPending(next, pending);
      this.commit(next);
    } catch (error) {
      const appError = appErrorFromUnknown(error, "Answering the extension UI request failed");
      this.fail(appError);
      throw error;
    }
  }

  public async answerHostTool(
    response: HostToolResponse,
    options?: PortCallOptions,
  ): Promise<void> {
    if (!this.transport.answerHostTool) {
      const error = errorForUnavailable("answerHostTool");
      this.fail(error);
      throw new AppFailure(error);
    }
    try {
      await this.transport.answerHostTool({ threadId: this.snapshot.threadId, response }, options);
      const next = mutableSnapshot(this.snapshot);
      const pending = copyPending(next);
      delete pending.hostTools[response.id];
      setPending(next, pending);
      this.commit(next);
    } catch (error) {
      const appError = appErrorFromUnknown(error, "Answering the host tool request failed");
      this.fail(appError);
      throw error;
    }
  }

  public async answerHostUri(response: HostUriResponse, options?: PortCallOptions): Promise<void> {
    if (!this.transport.answerHostUri) {
      const error = errorForUnavailable("answerHostUri");
      this.fail(error);
      throw new AppFailure(error);
    }
    try {
      await this.transport.answerHostUri({ threadId: this.snapshot.threadId, response }, options);
      const next = mutableSnapshot(this.snapshot);
      const pending = copyPending(next);
      delete pending.hostUris[response.id];
      setPending(next, pending);
      this.commit(next);
    } catch (error) {
      const appError = appErrorFromUnknown(error, "Answering the host URI request failed");
      this.fail(appError);
      throw error;
    }
  }

  public clearError(): void {
    if (this.snapshot.error === null) return;
    const next = mutableSnapshot(this.snapshot);
    next.error = null;
    this.commit(next);
  }

  private fail(error: AppError): void {
    const next = mutableSnapshot(this.snapshot);
    setError(next, error);
    this.commit(next);
  }

  private commit(next: MutableSnapshot): void {
    next.revision = this.snapshot.revision + 1;
    // Structural sharing: unchanged branches are reused and changed ones are frozen (Immer auto-freeze),
    // so an event costs the size of what it changed, not the size of the whole session.
    this.snapshot = finishDraft(next as unknown as Draft<RuntimeSnapshot>);
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private reduceProcess(
    next: MutableSnapshot,
    status: ProcessState["status"],
    error?: AppError,
  ): void {
    const previousStatus = this.snapshot.process.status;
    const startsNewProcess =
      (status === "starting" || status === "ready") &&
      (previousStatus === "exited" ||
        previousStatus === "restarting" ||
        previousStatus === "stopped" ||
        previousStatus === "error");
    if (startsNewProcess) {
      next.processGeneration += 1;
      next.processId = processIdForGeneration(next.threadId, next.processGeneration);
      this.interruptStreamingMessages(next);
      this.streamKeys.clear();
    }
    setProcess(next, status, error);
    if (status === "exited") {
      this.interruptStreamingMessages(next);
      this.streamKeys.clear();
      cancelActiveTools(next);
      updatePrompt(next, { streaming: false });
    }
  }

  private interruptStreamingMessages(next: MutableSnapshot): void {
    const messages = next.messages as Record<string, RuntimeMessage>;
    const streaming = next.streaming as Record<string, RuntimeMessage>;
    const pending = next.pendingEnded as ProvisionalMessageKey[];
    for (const [key, message] of Object.entries(messages)) {
      if (!key.startsWith("stream:") || message.status !== "streaming") continue;
      const interrupted: RuntimeMessage = { ...message, status: "ended", interrupted: true };
      messages[key] = interrupted;
      delete streaming[key];
      const provisionalKey = key as ProvisionalMessageKey;
      if (!pending.includes(provisionalKey)) pending.push(provisionalKey);
    }
    updatePrompt(next, { streaming: false });
  }

  private forwardNotification(rawFrame: unknown, seq: number): void {
    if (!isRecord(rawFrame) || typeof rawFrame.type !== "string") return;
    for (const subscription of this.notificationSubscriptions) {
      if (subscription.types.has(rawFrame.type)) {
        subscription.listener(rawFrame as unknown as RuntimeNotificationFrame, seq);
      }
    }
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
    const result: PromptResultState = {
      type: "prompt_result",
      agentInvoked: rawEvent.agentInvoked,
      status: rawEvent.status,
      sessionSettled: rawEvent.sessionSettled,
      id: asString(rawEvent.id),
      error: isRecord(rawEvent.error)
        ? (cloneValue(rawEvent.error) as unknown as OmpWire.PromptError)
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
      case "extension_ui_request": {
        const id = asString(frame.id);
        if (!id) return;
        if (frame.method === "cancel") {
          const targetId = asString(frame.targetId);
          if (targetId) delete pending.extensionUi[targetId];
          setPending(next, pending);
          return;
        }
        if (
          frame.method !== "select" &&
          frame.method !== "confirm" &&
          frame.method !== "input" &&
          frame.method !== "editor" &&
          frame.method !== "ask"
        ) {
          return;
        }
        pending.extensionUi[id] = {
          request: cloneValue(frame) as unknown as OmpWire.ExtensionUiRequest,
          receivedSeq: seq,
        };
        setPending(next, pending);
        return;
      }
      case "host_tool_call": {
        const id = asString(frame.id);
        const toolCallId = asString(frame.toolCallId);
        const toolName = asString(frame.toolName);
        if (!id || !toolCallId || !toolName || !isRecord(frame.arguments)) return;
        pending.hostTools[id] = {
          request: cloneValue(frame) as unknown as OmpWire.HostToolCallRequest,
          receivedSeq: seq,
        };
        setPending(next, pending);
        return;
      }
      case "host_uri_request": {
        const id = asString(frame.id);
        const operation =
          frame.operation === "read" || frame.operation === "write" ? frame.operation : undefined;
        const url = asString(frame.url);
        if (!id || !operation || !url) return;
        pending.hostUris[id] = {
          request: cloneValue(frame) as unknown as OmpWire.HostUriRequest,
          receivedSeq: seq,
        };
        setPending(next, pending);
        return;
      }
      case "host_tool_cancel": {
        const targetId = asString(frame.targetId);
        if (targetId) delete pending.hostTools[targetId];
        setPending(next, pending);
        return;
      }
      case "host_uri_cancel": {
        const targetId = asString(frame.targetId);
        if (targetId) delete pending.hostUris[targetId];
        setPending(next, pending);
        return;
      }
      case "extension_error":
        if (typeof frame.error === "string") {
          setError(next, { code: "omp_error", message: frame.error, retryable: false });
        }
        return;
      case "rpc_frame_error":
        if (typeof frame.error === "string") {
          setError(next, { code: "omp_error", message: frame.error, retryable: true });
        }
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
        updatePrompt(next, {
          admitted: true,
          streaming: true,
          promptResult: null,
          sessionSettled: false,
        });
        return;
      case "agent_end":
        updatePrompt(next, { streaming: false });
        return;
      case "turn_end":
        updatePrompt(next, { streaming: false });
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
      case "queue_update":
        if (Array.isArray(event.steering) && Array.isArray(event.followUp)) {
          updateQueues(next, {
            steering: event.steering.filter((item): item is string => typeof item === "string"),
            followUp: event.followUp.filter((item): item is string => typeof item === "string"),
          });
        }
        return;
      case "todo_reminder": {
        // A reminder lists only the unfinished tasks when a turn stops. It is a transcript panel and
        // never replaces the todo state (omp v18.6.1 src/modes/components/todo-reminder.ts).
        if (!Array.isArray(event.todos)) return;
        const reminder: TodoReminderState = {
          todos: cloneValue(event.todos) as TodoItem[],
          attempt: typeof event.attempt === "number" ? event.attempt : 1,
          maxAttempts: typeof event.maxAttempts === "number" ? event.maxAttempts : 1,
          afterMessage: next.messageOrder.at(-1) ?? null,
        };
        next.todoReminders = [...next.todoReminders, reminder].slice(-MAX_TODO_REMINDERS);
        return;
      }
      case "todo_auto_clear":
        updateTodos(next, []);
        return;
      case "notice":
        if (event.level === "error" && typeof event.message === "string") {
          setError(next, { code: "omp_error", message: event.message, retryable: true });
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
    const record: RuntimeMessage = {
      key,
      message,
      status: "streaming",
      streamMessageId: messageId,
    };
    addOrReplaceMessage(next, key, record);
    if (!next.messageOrder.includes(key)) (next.messageOrder as MessageKey[]).push(key);
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
    const assistantEvent = event.assistantMessageEvent as OmpWire.AssistantMessageEvent | undefined;
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
    };
    addOrReplaceMessage(next, key, record);
    if (!next.messageOrder.includes(key)) (next.messageOrder as MessageKey[]).push(key);
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
    };
    addOrReplaceMessage(next, key, record);
    if (!next.messageOrder.includes(key)) (next.messageOrder as MessageKey[]).push(key);
    if (!(next.pendingEnded as ProvisionalMessageKey[]).includes(key)) {
      (next.pendingEnded as ProvisionalMessageKey[]).push(key);
    }
    updatePrompt(next, { admitted: true });
  }

  private reduceToolStart(next: MutableSnapshot, event: Record<string, unknown>): void {
    const toolCallId = asToolCallId(event.toolCallId);
    const toolName = asString(event.toolName);
    if (!toolCallId || !toolName) return;
    const tools = next.tools as Record<string, ToolCallState>;
    const previous = tools[toolCallId];
    tools[toolCallId] = {
      toolCallId,
      toolName,
      args: cloneValue(event.args),
      intent: asString(event.intent),
      status: "running",
      // Argument projections stream in before execution starts; keep the latest one.
      streamProjection: previous?.streamProjection,
    };
  }

  private reduceToolUpdate(
    next: MutableSnapshot,
    event: Record<string, unknown>,
    stream: boolean,
  ): void {
    const toolCallId = asToolCallId(event.toolCallId);
    const toolName = asString(event.toolName);
    if (!toolCallId || !toolName) return;
    const tools = next.tools as Record<string, ToolCallState>;
    const previous = tools[toolCallId];
    tools[toolCallId] = {
      toolCallId,
      toolName,
      args: event.args === undefined ? previous?.args : cloneValue(event.args),
      intent: previous?.intent,
      status: "partial",
      partialResult: stream ? previous?.partialResult : cloneValue(event.partialResult),
      streamProjection: stream ? cloneValue(event.update) : previous?.streamProjection,
      result: previous?.result,
      isError: previous?.isError,
    };
  }

  private reduceToolEnd(next: MutableSnapshot, event: Record<string, unknown>): void {
    const toolCallId = asToolCallId(event.toolCallId);
    const toolName = asString(event.toolName);
    if (!toolCallId || !toolName) return;
    const isError = event.isError === true;
    const previous = (next.tools as Record<string, ToolCallState>)[toolCallId];
    (next.tools as Record<string, ToolCallState>)[toolCallId] = {
      toolCallId,
      toolName,
      args: event.args === undefined ? previous?.args : cloneValue(event.args),
      intent: previous?.intent,
      status: isError ? "error" : "success",
      partialResult: previous?.partialResult,
      streamProjection: previous?.streamProjection,
      result: cloneValue(event.result),
      isError,
    };
    // omp derives its todo list from every successful `todo` result except `view`
    // (src/tools/todo.ts:194-199 at v18.6.1); the app follows the same rule.
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
      return current?.messageKey === undefined;
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
      };
      const order = next.messageOrder as MessageKey[];
      const originalIndex = order.indexOf(key);
      addOrReplaceMessage(next, persistedKey, persisted);
      removeMessage(next, key);
      if (originalIndex >= 0) order.splice(originalIndex, 0, persistedKey);
      mergeEntryMessageKey(next, pairedId, persistedKey);
      const pendingIndex = pending.indexOf(key);
      if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
      this.streamKeys.delete(message.streamMessageId ?? "");
    }
  }
}

export type { OmpMessage, TodoItem, TodoPhase };
