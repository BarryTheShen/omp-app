import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ChatSessionEvent, ProcessStatus } from "@omp-app/contracts";
import type {
  ChatEvent,
  ChatHostState,
  GoalAnswer,
  HostDialogRequest,
  PlanModeStatus,
  SubagentSnapshot,
  UiOpenUrlEvent,
} from "@omp-app/contracts/chat-host";
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

/** A `!` or `$` run while omp runs it; once it ends, the transcript holds it with omp's result. */
export interface ChatShellRun {
  readonly method: "bash" | "python";
  readonly input: string;
  readonly startedAt: number;
  /** `!!` or `$$`: omp keeps the run out of the model's context (known for the runs this browser started). */
  readonly excludeFromContext: boolean;
}

/**
 * What one of omp's built-in commands printed (`/session`, `/usage`, …), or a notification from omp or an extension:
 * shown in this browser only, as omp's TUI does.
 */
export interface ChatNotice {
  readonly id: number;
  readonly text: string;
  readonly level: "output" | "info" | "warning" | "error";
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
  /** The dialogs omp waits on (approvals, questions), oldest first. */
  readonly requests: readonly HostDialogRequest[];
  readonly shell: ChatShellRun | null;
  readonly notices: readonly ChatNotice[];
  /** The chat's subagents as omp's roster keeps them, in the order they were started. */
  readonly agents: readonly SubagentSnapshot[];
  /** omp's todo list, phase by phase; empty while the chat has none. */
  readonly todos: ChatHostState["todoPhases"];
  /** omp's plan mode for the chat; null until it is read. */
  readonly planMode: PlanModeStatus | null;
  /** A plan omp proposed for review, while plan mode is on and nothing was decided about it. */
  readonly proposal: PlanProposal | null;
  /** The chat's goal (goal mode); null without one. */
  readonly goal: GoalAnswer["goal"];
  /** The page a sign-in waits on (omp's `ui_open_url`), until the sign-in ends. */
  readonly signIn: SignInPage | null;
}

/** A sign-in's page to open: its address, a short local link to it when omp runs one, and omp's instructions. */
export type SignInPage = Omit<UiOpenUrlEvent, "type">;

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
  requests: [],
  shell: null,
  notices: [],
  agents: [],
  todos: [],
  planMode: null,
  proposal: null,
  goal: null,
  signIn: null,
};

/** A transcript to draw that is not a live chat (a subagent's, in the Agent Hub): its entries, and whether it runs. */
export function transcriptOnly(entries: readonly SessionEntry[], working: boolean): ChatSnapshot {
  return { ...EMPTY, entries, working, phase: "live" };
}

/** A plan omp proposed: its file and its name (the model's slug, as `approve_plan` takes it). */
export interface PlanProposal {
  readonly planFilePath: string;
  readonly title: string;
}

/** The plan in omp's answer to a `write` of `xd://propose`, if this is one; its name is what the model wrote. */
function proposalOf(result: unknown, args: unknown): PlanProposal | null {
  const xdev = (result as { readonly details?: { readonly xdev?: unknown } } | undefined)?.details
    ?.xdev as
    | { readonly tool?: unknown; readonly inner?: { readonly planFilePath?: unknown } }
    | undefined;
  const planFilePath = xdev?.inner?.planFilePath;
  if (xdev?.tool !== "propose" || typeof planFilePath !== "string") return null;
  const written = (args as { readonly content?: unknown } | undefined)?.content;
  const title =
    typeof written === "string" && written.trim() !== ""
      ? written.trim()
      : planFilePath.replace(/^local:\/\//, "").replace(/(-plan)?\.md$/, "");
  return { planFilePath, title };
}

/** omp's subagent lifecycle statuses, as its roster names them. */
const LIFECYCLE_STATUS = {
  started: "running",
  completed: "completed",
  failed: "failed",
  aborted: "aborted",
} as const satisfies Record<
  Extract<ChatEvent, { type: "subagent_lifecycle" }>["payload"]["status"],
  SubagentSnapshot["status"]
>;

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
  #requests: readonly HostDialogRequest[] = [];
  #shell: ChatShellRun | null = null;
  /** Commands and code this browser sent with `!!` or `$$`, until omp starts them. */
  readonly #excluded = new Set<string>();
  #notices: readonly ChatNotice[] = [];
  #agents: ReadonlyMap<string, SubagentSnapshot> = new Map();
  #agentList: readonly SubagentSnapshot[] = [];
  #todos: ChatHostState["todoPhases"] = [];
  #planMode: PlanModeStatus | null = null;
  #proposal: PlanProposal | null = null;
  #goal: GoalAnswer["goal"] = null;
  #signIn: SignInPage | null = null;

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

  /**
   * The chat's state as `get_state` read it: its model, thinking level, queue and (when given) todo list, and whether
   * omp is in a turn: a chat opened in the middle of a turn did not see it start.
   */
  setState(
    state: Pick<ChatHostState, "model" | "thinkingLevel" | "queuedMessages"> &
      Partial<Pick<ChatHostState, "todoPhases" | "isStreaming">>,
  ): void {
    this.#model = state.model === undefined ? null : toChatModel(state.model);
    this.#thinkingLevel = state.thinkingLevel ?? null;
    this.#queue = takeBackable(state.queuedMessages);
    if (state.todoPhases !== undefined) this.#todos = state.todoPhases;
    if (state.isStreaming === true) this.#startWorking();
    this.#publish();
  }

  /** omp turned out to be in a turn this page did not see start: what is sent now steers it. */
  markWorking(): void {
    this.#startWorking();
    this.#publish();
  }

  #startWorking(): void {
    if (this.#working) return;
    this.#working = true;
    this.#workingSince = Date.now();
  }

  setModel(model: ChatModel): void {
    this.#model = model;
    this.#publish();
  }

  setThinkingLevel(level: string | null): void {
    this.#thinkingLevel = level;
    this.#publish();
  }

  setPlanMode(status: PlanModeStatus): void {
    this.#planMode = status;
    this.#publish();
  }

  /** The proposal was approved, or the person keeps planning: the review goes. */
  clearProposal(): void {
    this.#proposal = null;
    this.#publish();
  }

  setGoal(goal: GoalAnswer["goal"]): void {
    this.#goal = goal;
    this.#publish();
  }

  /** The sign-in ended (signed in, refused or failed): its page is not shown any more. */
  clearSignIn(): void {
    this.#signIn = null;
    this.#publish();
  }

  /** omp's roster as `get_subagents` read it; the lifecycle and progress events keep it current from then on. */
  setAgents(agents: readonly SubagentSnapshot[]): void {
    this.#agents = new Map(agents.map((agent) => [agent.id, agent]));
    this.#listAgents();
    this.#publish();
  }

  #putAgent(agent: SubagentSnapshot): void {
    this.#agents = new Map(this.#agents).set(agent.id, agent);
    this.#listAgents();
  }

  #listAgents(): void {
    this.#agentList = [...this.#agents.values()].sort((a, b) => a.index - b.index);
  }

  /**
   * The dialogs the server still holds open when the chat opens (a replayed history cannot tell them from answered
   * ones), followed by any that arrived live since.
   */
  restoreRequests(open: readonly HostDialogRequest[]): void {
    const ids = new Set(open.map((request) => request.id));
    this.#requests = [...open, ...this.#requests.filter((request) => !ids.has(request.id))];
    this.#publish();
  }

  addRequest(request: HostDialogRequest): void {
    if (this.#requests.some((open) => open.id === request.id)) return;
    this.#requests = [...this.#requests, request];
    this.#publish();
  }

  removeRequest(id: string): void {
    if (!this.#requests.some((open) => open.id === id)) return;
    this.#requests = this.#requests.filter((open) => open.id !== id);
    this.#publish();
  }

  dismissNotice(id: number): void {
    this.#notices = this.#notices.filter((notice) => notice.id !== id);
    this.#publish();
  }

  /** A notice from the page itself, such as an edit omp refused. */
  addNotice(text: string, level: ChatNotice["level"]): void {
    this.#notify(text, level);
    this.#publish();
  }

  /** A run this browser is about to send, so its box can say whether omp keeps it out of context. */
  expectShell(input: string, excludeFromContext: boolean): void {
    if (excludeFromContext) this.#excluded.add(input);
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
          // A process that has ended waits on nothing.
          this.#requests = [];
        }
        break;
      case "shell":
        if (payload.status === "running") {
          this.#shell = {
            method: payload.method,
            input: payload.input,
            startedAt: payload.startedAt,
            excludeFromContext: this.#excluded.delete(payload.input),
          };
        } else {
          const excluded =
            this.#shell?.startedAt === payload.startedAt
              ? this.#shell.excludeFromContext
              : this.#excluded.delete(payload.input);
          this.#shell = null;
          // omp's result is the run as omp records it; a new chat's file is not written until omp's first reply.
          if (payload.result !== undefined)
            this.#appendShellRun(payload.method, payload.input, payload.startedAt, {
              ...payload.result,
              excludeFromContext: excluded,
            });
        }
        break;
      default:
        // Host requests come through the controller, which tells live ones from replayed history.
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
        const started = this.#activeTools.get(event.toolCallId);
        const next = new Map(this.#activeTools);
        next.delete(event.toolCallId);
        this.#activeTools = next;
        if (event.isError === true) return false;
        // omp's todo tool answers every change with the whole list.
        if (event.toolName === "todo") {
          const phases = (
            event.result as { readonly details?: { readonly phases?: unknown } } | undefined
          )?.details?.phases;
          if (Array.isArray(phases)) this.#todos = phases as ChatHostState["todoPhases"];
        }
        // In plan mode the model submits its plan by writing the plan's name to `xd://propose`; omp's answer names the file.
        if (event.toolName === "write") {
          const proposed = proposalOf(event.result, started?.args);
          if (proposed !== null) this.#proposal = proposed;
        }
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
      case "ui_cancel":
        // omp closed the dialog itself (its signal aborted or its timeout passed).
        this.#requests = this.#requests.filter((open) => open.id !== event.requestId);
        return false;
      case "command_output":
        this.#notify(event.text, "output");
        return false;
      case "goal_updated":
        this.#goal = event.goal;
        return false;
      case "ui_notify":
        this.#notify(event.message, event.notifyType ?? "info");
        return false;
      case "ui_open_url":
        this.#signIn = {
          url: event.url,
          ...(event.launchUrl === undefined ? {} : { launchUrl: event.launchUrl }),
          ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
        };
        return false;
      case "subagent_lifecycle": {
        const { payload } = event;
        const known = this.#agents.get(payload.id);
        this.#putAgent({
          ...known,
          id: payload.id,
          index: payload.index,
          agent: payload.agent,
          agentSource: payload.agentSource,
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.sessionFile === undefined ? {} : { sessionFile: payload.sessionFile }),
          ...(payload.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: payload.parentToolCallId }),
          status: LIFECYCLE_STATUS[payload.status],
          lastUpdate: Date.now(),
        });
        return true;
      }
      case "subagent_progress": {
        const { payload } = event;
        const { progress } = payload;
        const known = this.#agents.get(progress.id);
        this.#putAgent({
          ...known,
          id: progress.id,
          index: payload.index,
          agent: payload.agent,
          agentSource: payload.agentSource,
          task: payload.task,
          ...(payload.assignment === undefined ? {} : { assignment: payload.assignment }),
          ...(progress.description === undefined ? {} : { description: progress.description }),
          ...(payload.sessionFile === undefined ? {} : { sessionFile: payload.sessionFile }),
          ...(payload.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: payload.parentToolCallId }),
          status: progress.status,
          progress,
          lastUpdate: Date.now(),
        });
        return true;
      }
      default:
        return false;
    }
  }

  #notify(text: string, level: ChatNotice["level"]): void {
    this.#notices = [...this.#notices, { id: (this.#notices.at(-1)?.id ?? 0) + 1, text, level }];
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

  /**
   * Adds an ended run as omp records it (its `bashExecution` or `pythonExecution` message), unless the transcript read
   * it from the file already: a run replayed from earlier in the server's run.
   */
  #appendShellRun(
    method: "bash" | "python",
    input: string,
    startedAt: number,
    result: {
      readonly output: string;
      readonly exitCode: number | undefined;
      readonly cancelled: boolean;
      readonly truncated: boolean;
      readonly excludeFromContext: boolean;
    },
  ): void {
    const role = method === "bash" ? "bashExecution" : "pythonExecution";
    const saved = this.#entries.some((entry) => {
      if (entry.type !== "message") return false;
      const message = entry.message as unknown as Record<string, unknown>;
      return (
        message.role === role &&
        (method === "bash" ? message.command : message.code) === input &&
        message.output === result.output &&
        typeof message.timestamp === "number" &&
        message.timestamp >= startedAt
      );
    });
    if (saved) return;
    const now = Date.now();
    const message = {
      role,
      ...(method === "bash" ? { command: input } : { code: input }),
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      excludeFromContext: result.excludeFromContext,
      timestamp: now,
    };
    const entry = {
      type: "message",
      id: `live-shell-${startedAt}`,
      parentId: this.#entries.at(-1)?.id ?? null,
      timestamp: new Date(now).toISOString(),
      message,
    } as unknown as SessionEntry;
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
      requests: this.#requests,
      shell: this.#shell,
      notices: this.#notices,
      agents: this.#agentList,
      todos: this.#todos,
      planMode: this.#planMode,
      proposal: this.#proposal,
      goal: this.#goal,
      signIn: this.#signIn,
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
