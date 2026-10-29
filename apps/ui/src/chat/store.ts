import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ChatSessionEvent, ProcessStatus } from "@omp-app/contracts";
import type { ChatEvent, ChatHostState } from "@omp-app/contracts/chat-host";
import type { ActiveTool, ConnectionPhase } from "../vendor/collab-web/lib/types";

/** The chat's model, as the message box names it. */
export interface ChatModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

/** Messages waiting in omp's two queues that can still be taken back (not yet sent into the reply). */
export interface ChatQueue {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

/** What omp is doing, for the working row above the message box. */
export interface ChatActivity {
  readonly since: number;
  readonly label: string;
}

/** What a chat pane draws: the props of collab-web's transcript, plus the chat's own state. */
export interface ChatSnapshot {
  readonly entries: readonly SessionEntry[];
  /** The reply being written; null between replies. */
  readonly stream: AssistantMessage | null;
  readonly streamDone: boolean;
  readonly activeTools: ReadonlyMap<string, ActiveTool>;
  /** From omp's `agent_start` to its `agent_end`. */
  readonly working: boolean;
  readonly phase: ConnectionPhase;
  readonly process: ProcessStatus | null;
  /** Whether the session file holds entries older than the first one shown. */
  readonly hasOlder: boolean;
  readonly model: ChatModel | null;
  /** omp's thinking level for the chat; null when the model has none. */
  readonly thinkingLevel: string | null;
  readonly queue: ChatQueue;
  /** Null while omp is idle. */
  readonly activity: ChatActivity | null;
}

const NO_QUEUE: ChatQueue = { steering: [], followUp: [] };

const EMPTY: ChatSnapshot = {
  entries: [],
  stream: null,
  streamDone: false,
  activeTools: new Map(),
  working: false,
  phase: "connecting",
  process: null,
  hasOlder: false,
  model: null,
  thinkingLevel: null,
  queue: NO_QUEUE,
  activity: null,
};

type MessageUpdate = Extract<ChatEvent, { type: "message_update" }>;
type StreamDelta = Extract<MessageUpdate, { messageId: string }>["assistantMessageEvent"];
type ContentBlock = AssistantMessage["content"][number];

/** A message's role and time: how a message from the live stream is matched with the same message read from the file. */
function messageKey(entry: SessionEntry): string | null {
  if (entry.type !== "message") return null;
  const message = entry.message as { readonly role: string; readonly timestamp?: number };
  return message.timestamp === undefined ? null : `${message.role}:${message.timestamp}`;
}

function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
}

/** The queue as omp reports it, without the steering messages already sent into the reply. */
function takeBackable(queue: {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly liveSteered: number;
}): ChatQueue {
  if (queue.steering.length === 0 && queue.followUp.length === 0) return NO_QUEUE;
  return { steering: queue.steering.slice(queue.liveSteered), followUp: queue.followUp };
}

export function toChatModel(model: NonNullable<ChatHostState["model"]>): ChatModel {
  return { provider: model.provider, id: model.id, name: model.name };
}

/**
 * One chat's live state, read by React through `subscribe` and `getSnapshot` (`useSyncExternalStore`). Events apply at
 * once; streaming updates (`message_update`, `tool_execution_update`) publish at most once per animation frame, and
 * every other change publishes at once together with anything still pending.
 */
export class ChatStore {
  #snapshot: ChatSnapshot = EMPTY;
  readonly #listeners = new Set<() => void>();
  #cancelFrame: (() => void) | null = null;

  #entries: readonly SessionEntry[] = [];
  #keys = new Set<string>();
  #hasOlder = false;
  #stream: AssistantMessage | null = null;
  #streamDone = false;
  #activeTools: ReadonlyMap<string, ActiveTool> = new Map();
  #working = false;
  #phase: ConnectionPhase = "connecting";
  #process: ProcessStatus | null = null;
  #model: ChatModel | null = null;
  #thinkingLevel: string | null = null;
  #queue: ChatQueue = NO_QUEUE;
  #workingSince = 0;
  #compacting = false;
  #retry: { readonly attempt: number; readonly maxAttempts: number } | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): ChatSnapshot => this.#snapshot;

  /** The oldest entry shown, to read the next older window from. */
  get oldestId(): string | null {
    return this.#entries[0]?.id ?? null;
  }

  /** Replaces the transcript with the newest window of the session file, oldest first. */
  setWindow(entries: readonly SessionEntry[], hasOlder: boolean): void {
    this.#entries = entries;
    this.#keys = new Set(entries.map(messageKey).filter((key) => key !== null));
    this.#hasOlder = hasOlder;
    // A reply that the file now holds is shown from the file.
    if (this.#stream !== null && this.#streamDone) this.#stream = null;
    this.#publish();
  }

  /** Adds an older window of the session file in front of the transcript. */
  prependWindow(older: readonly SessionEntry[], hasOlder: boolean): void {
    const shown = new Set(this.#entries.map((entry) => entry.id));
    const fresh = older.filter((entry) => !shown.has(entry.id));
    for (const entry of fresh) {
      const key = messageKey(entry);
      if (key !== null) this.#keys.add(key);
    }
    this.#entries = [...fresh, ...this.#entries];
    this.#hasOlder = hasOlder;
    this.#publish();
  }

  setPhase(phase: ConnectionPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#publish();
  }

  /** The chat's state as `get_state` read it: its model, thinking level and queue. */
  setState(state: Pick<ChatHostState, "model" | "thinkingLevel" | "queuedMessages">): void {
    this.#model = state.model === undefined ? null : toChatModel(state.model);
    this.#thinkingLevel = state.thinkingLevel ?? null;
    this.#queue = takeBackable(state.queuedMessages);
    this.#publish();
  }

  setModel(model: ChatModel): void {
    this.#model = model;
    this.#publish();
  }

  setThinkingLevel(level: string | null): void {
    this.#thinkingLevel = level;
    this.#publish();
  }

  apply(payload: ChatSessionEvent): void {
    switch (payload.kind) {
      case "event":
        if (this.#applyEvent(payload.event)) {
          this.#publishSoon();
          return;
        }
        break;
      case "process":
        this.#process = payload.status;
        if (
          payload.status === "exited" ||
          payload.status === "stopped" ||
          payload.status === "error"
        ) {
          this.#working = false;
          this.#activeTools = new Map();
          this.#compacting = false;
          this.#retry = null;
        }
        break;
      default:
        // Host requests, shell runs and moves are drawn by later modules.
        return;
    }
    this.#publish();
  }

  /** Applies one chat-host event; true when it may wait for the next frame to be shown. */
  #applyEvent(event: ChatEvent): boolean {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.#stream = event.message as unknown as AssistantMessage;
          this.#streamDone = false;
        }
        return false;
      case "message_update":
        if (event.message.role !== "assistant") return true;
        if ("content" in event.message) {
          this.#stream = event.message as unknown as AssistantMessage;
        } else if ("messageId" in event && this.#stream !== null) {
          this.#stream = applyDelta(this.#stream, event.assistantMessageEvent);
        }
        this.#streamDone = false;
        return true;
      case "message_end": {
        const message = event.message as unknown as SessionMessage;
        this.#append(message, event.messageId);
        if (message.role === "assistant") {
          this.#stream = null;
          this.#streamDone = false;
        }
        return false;
      }
      case "tool_execution_start": {
        const tool: ActiveTool = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          startedAt: Date.now(),
          ...(typeof event.intent === "string" ? { intent: event.intent } : {}),
        };
        this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
        return false;
      }
      case "tool_execution_update": {
        const existing = this.#activeTools.get(event.toolCallId);
        const tool: ActiveTool = existing
          ? { ...existing, partialResult: event.partialResult }
          : {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              partialResult: event.partialResult,
              startedAt: Date.now(),
            };
        this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
        return true;
      }
      case "tool_execution_end": {
        const next = new Map(this.#activeTools);
        next.delete(event.toolCallId);
        this.#activeTools = next;
        return false;
      }
      case "agent_start":
        this.#working = true;
        this.#workingSince = Date.now();
        return false;
      case "agent_end":
        this.#working = false;
        this.#activeTools = new Map();
        this.#retry = null;
        return false;
      case "thinking_level_changed":
        this.#thinkingLevel = event.configured ?? event.thinkingLevel ?? null;
        return false;
      case "queue_update":
        this.#queue = takeBackable(event);
        return false;
      case "auto_compaction_start":
        this.#compacting = true;
        if (!this.#working) this.#workingSince = Date.now();
        return false;
      case "auto_compaction_end":
        this.#compacting = false;
        return false;
      case "auto_retry_start":
        this.#retry = { attempt: event.attempt, maxAttempts: event.maxAttempts };
        return false;
      case "auto_retry_end":
        this.#retry = null;
        return false;
      default:
        return false;
    }
  }

  /** Adds a finished message from the live stream, unless the transcript already holds it (read from the file). */
  #append(message: SessionMessage, messageId: string): void {
    const entry = {
      type: "message",
      id: `live-${messageId}-${message.timestamp ?? Date.now()}`,
      parentId: this.#entries.at(-1)?.id ?? null,
      timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
      message,
    } as unknown as SessionEntry;
    const key = messageKey(entry);
    if (key !== null) {
      if (this.#keys.has(key)) return;
      this.#keys.add(key);
    }
    this.#entries = [...this.#entries, entry];
  }

  /** The working row's line: the step omp is on, most specific first. */
  #activityLabel(): string {
    if (this.#compacting) return "Compacting the chat";
    if (this.#retry !== null)
      return `Retrying, attempt ${this.#retry.attempt} of ${this.#retry.maxAttempts}`;
    let tool: ActiveTool | undefined;
    for (const candidate of this.#activeTools.values()) tool = candidate;
    if (tool !== undefined) return tool.intent ?? `Running ${tool.toolName}`;
    const last = this.#stream?.content.at(-1);
    if (last?.type === "thinking") return "Thinking";
    if (last?.type === "text") return "Writing";
    return "Working";
  }

  #publishSoon(): void {
    if (this.#cancelFrame !== null) return;
    this.#cancelFrame = scheduleFrame(() => {
      this.#cancelFrame = null;
      this.#commit();
    });
  }

  #publish(): void {
    if (this.#cancelFrame !== null) {
      this.#cancelFrame();
      this.#cancelFrame = null;
    }
    this.#commit();
  }

  #commit(): void {
    const previous = this.#snapshot.activity;
    let activity: ChatActivity | null = null;
    if (this.#working || this.#compacting) {
      const label = this.#activityLabel();
      activity =
        previous?.since === this.#workingSince && previous.label === label
          ? previous
          : { since: this.#workingSince, label };
    }
    this.#snapshot = {
      entries: this.#entries,
      stream: this.#stream,
      streamDone: this.#streamDone,
      activeTools: this.#activeTools,
      working: this.#working,
      phase: this.#phase,
      process: this.#process,
      hasOlder: this.#hasOlder,
      model: this.#model,
      thinkingLevel: this.#thinkingLevel,
      queue: this.#queue,
      activity,
    };
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#listeners.clear();
  }
}

interface SessionMessage {
  readonly role: string;
  readonly timestamp?: number;
}

/** The reply so far with one streaming increment added (the `delta` form of `message_update`). */
export function applyDelta(message: AssistantMessage, delta: StreamDelta): AssistantMessage {
  switch (delta.type) {
    case "done":
      return delta.message as unknown as AssistantMessage;
    case "error":
      return delta.error as unknown as AssistantMessage;
    case "start":
    case "toolcall_delta":
      return message;
    default:
      break;
  }
  const index = delta.contentIndex;
  const content = [...message.content];
  const block = content[index];
  let next: ContentBlock;
  switch (delta.type) {
    case "text_start":
      next = { type: "text", text: "" };
      break;
    case "text_delta":
      next = { type: "text", text: (block?.type === "text" ? block.text : "") + delta.delta };
      break;
    case "text_end":
      next = {
        ...(block?.type === "text" ? block : { type: "text" as const }),
        text: delta.content,
      };
      break;
    case "thinking_start":
      next = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta":
      next = {
        type: "thinking",
        thinking: (block?.type === "thinking" ? block.thinking : "") + delta.delta,
      };
      break;
    case "thinking_end":
      next = {
        ...(block?.type === "thinking" ? block : { type: "thinking" as const }),
        thinking: delta.content,
      };
      break;
    case "image_end":
      next = delta.content as unknown as ContentBlock;
      break;
    case "toolcall_start":
      // The call's id and name come with its end; until then it shows as a call being written.
      next = { type: "toolCall", id: `pending-${index}`, name: "", arguments: {} } as ContentBlock;
      break;
    case "toolcall_end":
      next = delta.toolCall as unknown as ContentBlock;
      break;
  }
  content[index] = next;
  return { ...message, content };
}
