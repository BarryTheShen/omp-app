import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import type { ChatSessionEvent, ProcessStatus, UsagePauseHold } from "@omp-app/contracts";
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

/** A chat's usage pause (#2781 part 3): the share of its provider's 5-hour window it pauses at, and the rule's hold. */
export interface ChatUsagePause {
  readonly percent: number;
  readonly hold: UsagePauseHold | null;
}

function usagePauseKey(usagePause: ChatUsagePause | null): string {
  if (usagePause === null) return "";
  const { percent, hold } = usagePause;
  return hold === null ? `${percent}` : `${percent}:${hold.providerId}:${hold.until ?? "-"}`;
}

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
 * What one of omp's built-in commands printed (`/session`, `/usage`, …), or something that explains the chat itself (it
 * could not open, a part of it is missing, omp could not save it): a row at the transcript's end, in this browser only,
 * as omp's TUI prints it, until dismissed.
 */
export interface ChatNotice {
  readonly id: number;
  readonly text: string;
  /** `status`: one of omp's status lines, too long for a toast: a dim line in the chat, as omp's terminal shows it. */
  readonly level: "output" | "status" | "info" | "warning" | "error";
  /** A service this chat started, shared by itself (#2788): its one-time link, null while a new one is made. */
  readonly share?: { readonly id: string; readonly url: string | null };
}

/**
 * One of omp's status lines (a model switched, a side answer ready, an action that failed): a toast above the message
 * box for a moment, as Tern draws it, one at a time, a new one replacing the one shown.
 */
export interface ChatToast {
  readonly id: number;
  readonly text: string;
  readonly tone: "success" | "info" | "warning" | "error";
}

/** After Ctrl+P: the roles it walks, in their order, and the one switched to; shown for a moment above the box. */
export interface RoleTrack {
  readonly order: readonly string[];
  readonly current: string;
  /** Tells one switch's track from the next one's. */
  readonly id: number;
}

/** What a chat pane draws: the props of collab-web's transcript, plus the chat's own state. */
export interface ChatSnapshot {
  readonly entries: readonly SessionEntry[];
  /** The reply being written; null between replies. */
  readonly stream: AssistantMessage | null;
  readonly streamDone: boolean;
  readonly activeTools: ReadonlyMap<string, ActiveTool>;
  /**
   * What a command left running in the background reported last, by the call that started it (omp's job frame,
   * `details.async`): the call's own card shows it, filling and settling with the job (#2800).
   */
  readonly jobs: ReadonlyMap<string, unknown>;
  /** From omp's `agent_start` to its `agent_end`. */
  readonly working: boolean;
  /** When the chat's pause began (omp's pause gate holds its agents, `/pause`); null while it runs. */
  readonly pausedAt: number | null;
  /**
   * Messages sent while the chat is paused: omp holds them before it shows them (its loop parks before a turn's input),
   * so the paused row says they wait. Gone once the chat goes on, when omp shows them in the chat.
   */
  readonly held: readonly string[];
  /**
   * When the app continues this chat by itself after a usage limit stopped it (epoch ms, #2781), as the server says; null
   * when it will not. The failed request's row says when.
   */
  readonly continuesAt: number | null;
  /**
   * The chat's usage pause (#2781 part 3), as the server says: it pauses at `percent` of its provider's 5-hour window,
   * and `hold` is set while that rule holds it paused. null when the chat is not marked.
   */
  readonly usagePause: ChatUsagePause | null;
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
  /** omp's latest status line while it shows; null otherwise. */
  readonly toast: ChatToast | null;
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
  /** The role whose model the chat runs (omp's `smol`, `default`, `slow`, …); null when none, or the server cannot tell. */
  readonly role: string | null;
  readonly roleTrack: RoleTrack | null;
}

/**
 * A sign-in's page to open: its address and omp's instructions. omp's short link to it (`launchUrl`) is left out: it is a
 * page of omp's own computer (`localhost`), which the device in use cannot open when that is another one.
 */
export type SignInPage = Omit<UiOpenUrlEvent, "type" | "launchUrl">;

const NO_QUEUE: ChatQueue = { steering: [], followUp: [] };

const EMPTY: ChatSnapshot = {
  entries: [],
  stream: null,
  streamDone: false,
  activeTools: new Map(),
  jobs: new Map(),
  working: false,
  pausedAt: null,
  held: [],
  continuesAt: null,
  usagePause: null,
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
  toast: null,
  agents: [],
  todos: [],
  planMode: null,
  proposal: null,
  goal: null,
  signIn: null,
  role: null,
  roleTrack: null,
};

/** A transcript to draw that is not a live chat (a subagent's, in the Agent Hub): its entries, and whether it runs. */
export function transcriptOnly(entries: readonly SessionEntry[], working: boolean): ChatSnapshot {
  return { ...EMPTY, entries, working, phase: "live" };
}

/** omp's job frame: a backgrounded command's report on the call that started it, with the job's state (`details.async`). */
function isJobFrame(partialResult: unknown): boolean {
  const details = (partialResult as { readonly details?: unknown } | null | undefined)?.details;
  return (
    typeof details === "object" &&
    details !== null &&
    typeof (details as { readonly async?: unknown }).async === "object" &&
    (details as { readonly async?: unknown }).async !== null
  );
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

/**
 * A toast is a status line. A note longer than two lines' worth, or one on several lines (such as the list of tools an
 * MCP server brought), stays in the chat as a row instead, where it can be read in full and dismissed.
 */
const TOAST_MAX_CHARACTERS = 160;

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
  /** Messages taken from events since the file's window was set that the window did not hold (no omp entry id yet). */
  #beyondWindow = false;
  #hasOlder = false;
  #stream: AssistantMessage | null = null;
  #streamDone = false;
  #activeTools: ReadonlyMap<string, ActiveTool> = new Map();
  #jobs: ReadonlyMap<string, unknown> = new Map();
  #working = false;
  #activityMark = 0;
  #phase: ConnectionPhase = "connecting";
  #process: ProcessStatus | null = null;
  #model: ChatModel | null = null;
  #thinkingLevel: string | null = null;
  #queue: ChatQueue = NO_QUEUE;
  #workingSince = 0;
  #compacting = false;
  #pausedAt: number | null = null;
  #held: readonly string[] = [];
  #continuesAt: number | null = null;
  #usagePause: ChatUsagePause | null = null;
  #retry: { readonly attempt: number; readonly maxAttempts: number } | null = null;
  #requests: readonly HostDialogRequest[] = [];
  #shell: ChatShellRun | null = null;
  /** Commands and code this browser sent with `!!` or `$$`, until omp starts them. */
  readonly #excluded = new Set<string>();
  #notices: readonly ChatNotice[] = [];
  #toast: ChatToast | null = null;
  /** Never reused, so a toast's timer can only end that toast. */
  #toastSeq = 0;
  #agents: ReadonlyMap<string, SubagentSnapshot> = new Map();
  #agentList: readonly SubagentSnapshot[] = [];
  #todos: ChatHostState["todoPhases"] = [];
  #planMode: PlanModeStatus | null = null;
  #proposal: PlanProposal | null = null;
  #goal: GoalAnswer["goal"] = null;
  #signIn: SignInPage | null = null;
  #role: string | null = null;
  #roleTrack: RoleTrack | null = null;

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
    this.#beyondWindow = false;
    // A reply that the file now holds is shown from the file.
    if (this.#stream !== null && this.#streamDone) this.#stream = null;
    this.#publish();
  }

  /**
   * Whether messages came in by events since the file's window was set that the window did not hold: they show without
   * omp's entry ids (which Edit needs) until the window is read again.
   */
  get beyondWindow(): boolean {
    return this.#beyondWindow;
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

  /** When the app continues this chat after its usage limit (#2781); null when it will not. */
  setContinuesAt(continuesAt: number | null): void {
    if (this.#continuesAt === continuesAt) return;
    this.#continuesAt = continuesAt;
    this.#publish();
  }

  /** The chat's usage pause as the server has it now (#2781 part 3); null when the chat is not marked. */
  setUsagePause(usagePause: ChatUsagePause | null): void {
    if (usagePauseKey(this.#usagePause) === usagePauseKey(usagePause)) return;
    this.#usagePause = usagePause;
    this.#publish();
  }

  /**
   * Counts the starts and ends of turns and compactions this store has taken. A state read is asked at one count and
   * answers at a later one: when the count moved in between, those events are newer than the read.
   */
  get activityMark(): number {
    return this.#activityMark;
  }

  /**
   * The chat's state as `get_state` read it: its model, thinking level, queue and (when given) todo list. `asked` is
   * `activityMark` when the read was asked: unless a turn or a compaction started or ended since, the read also says
   * whether omp works and compacts, for a page that opened in the middle of a turn or missed events in a reconnect.
   */
  setState(
    state: Pick<ChatHostState, "model" | "thinkingLevel" | "queuedMessages"> &
      Partial<Pick<ChatHostState, "todoPhases" | "isStreaming" | "isCompacting" | "pausedAt">>,
    asked: number,
  ): void {
    this.#model = state.model === undefined ? null : toChatModel(state.model);
    this.#thinkingLevel = state.thinkingLevel ?? null;
    this.#queue = takeBackable(state.queuedMessages);
    if (state.todoPhases !== undefined) this.#todos = state.todoPhases;
    // A full read: no `pausedAt` is a chat that runs.
    this.#pausedAt = state.pausedAt ?? null;
    if (this.#pausedAt === null) this.#held = [];
    if (asked === this.#activityMark) {
      if (state.isStreaming === true) this.#startWorking();
      if (state.isStreaming === false) this.#stopWorking();
      if (state.isCompacting !== undefined) this.#setCompacting(state.isCompacting);
    }
    this.#publish();
  }

  /** A message was sent while the chat is paused: it waits, and the paused row says so. */
  holdMessage(text: string): void {
    this.#held = [...this.#held, text];
    this.#publish();
  }

  /** omp turned out to be in a turn this page did not see start: what is sent now steers it. */
  markWorking(): void {
    this.#activityMark += 1;
    this.#startWorking();
    this.#publish();
  }

  #startWorking(): void {
    if (this.#working) return;
    this.#working = true;
    this.#workingSince = Date.now();
  }

  #stopWorking(): void {
    this.#working = false;
    this.#activeTools = new Map();
    this.#retry = null;
  }

  #setCompacting(compacting: boolean): void {
    if (compacting && !this.#compacting && !this.#working) this.#workingSince = Date.now();
    this.#compacting = compacting;
  }

  setModel(model: ChatModel): void {
    this.#model = model;
    this.#publish();
  }

  setThinkingLevel(level: string | null): void {
    this.#thinkingLevel = level;
    this.#publish();
  }

  /** The live model's role as omp reports it (`get_role_models`); null for none, or a server without roles. */
  setRole(role: string | null): void {
    this.#role = role;
    this.#publish();
  }

  /**
   * After Ctrl+P: the role switched to, its model and the thinking level it names (null keeps the level), all at once,
   * and the roles in order with that one marked until `hideRoleTrack` with its id. The model is not left to omp's later
   * report, so the chip never names the new role with the old model.
   */
  switchRole(
    order: readonly string[],
    role: string,
    model: ChatModel,
    thinkingLevel: string | null,
  ): void {
    this.#role = role;
    this.#model = model;
    if (thinkingLevel !== null) this.#thinkingLevel = thinkingLevel;
    if (order.length > 0)
      this.#roleTrack = { order, current: role, id: (this.#roleTrack?.id ?? 0) + 1 };
    this.#publish();
  }

  hideRoleTrack(id: number): void {
    if (this.#roleTrack?.id !== id) return;
    this.#roleTrack = null;
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

  /** A row from the page itself that explains the chat: it could not open, or a part of it is not shown. */
  addNotice(text: string, level: ChatNotice["level"]): void {
    this.#notify(text, level);
    this.#publish();
  }

  /** A service this chat started was shared (#2788): a row that says so, with a link the controller keeps fresh. */
  addShareNotice(text: string, shareId: string): void {
    this.#notices = [
      ...this.#notices,
      {
        id: (this.#notices.at(-1)?.id ?? 0) + 1,
        text,
        level: "info",
        share: { id: shareId, url: null },
      },
    ];
    this.#publish();
  }

  /** The shared service's one-time link changed: made again, or taken. */
  setShareLink(shareId: string, url: string | null): void {
    if (!this.#notices.some((notice) => notice.share?.id === shareId)) return;
    this.#notices = this.#notices.map((notice) =>
      notice.share?.id === shareId ? { ...notice, share: { id: shareId, url } } : notice,
    );
    this.#publish();
  }

  /** One of omp's status lines, or the page's own (an action that failed): it replaces the toast shown; a long one is a row. */
  toast(text: string, tone: ChatToast["tone"]): void {
    this.#showToast(text, tone);
    this.#publish();
  }

  /** The toast's time is up (its id: a newer one stays). */
  dismissToast(id: number): void {
    if (this.#toast?.id !== id) return;
    this.#toast = null;
    this.#publish();
  }

  #showToast(text: string, tone: ChatToast["tone"]): void {
    if (text.length > TOAST_MAX_CHARACTERS || text.includes("\n")) {
      // Too long for a toast: a status line stays a dim line in the chat, as in omp's terminal (a list of mounted
      // tools at each start); a warning or an error is a notice to read.
      this.#notify(text, tone === "info" || tone === "success" ? "status" : tone);
      return;
    }
    this.#toastSeq += 1;
    this.#toast = { id: this.#toastSeq, text, tone };
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
          this.#activityMark += 1;
          this.#stopWorking();
          this.#compacting = false;
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
        // A call that returned with its command still running in the background reports on that call as the job goes
        // on: the call's own card shows it, rather than the call coming back as one running at the chat's end (#2800).
        if (existing === undefined && isJobFrame(event.partialResult)) {
          this.#jobs = new Map(this.#jobs).set(event.toolCallId, event.partialResult);
          return true;
        }
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
        this.#activityMark += 1;
        this.#working = true;
        this.#workingSince = Date.now();
        // A retried tool batch (omp's tool replay): the calls run again, so their old results go.
        if (event.resumedToolCallIds !== undefined && event.resumedToolCallIds.length > 0)
          this.#dropReplayed(new Set(event.resumedToolCallIds));
        return false;
      case "agent_end":
        this.#activityMark += 1;
        this.#stopWorking();
        return false;
      case "thinking_level_changed":
        this.#thinkingLevel = event.configured ?? event.thinkingLevel ?? null;
        return false;
      case "queue_update":
        this.#queue = takeBackable(event);
        return false;
      case "auto_compaction_start":
        this.#activityMark += 1;
        this.#setCompacting(true);
        return false;
      case "auto_compaction_end":
        this.#activityMark += 1;
        this.#setCompacting(false);
        return false;
      case "auto_retry_start":
        this.#retry = { attempt: event.attempt, maxAttempts: event.maxAttempts };
        return false;
      case "auto_retry_end":
        this.#retry = null;
        return false;
      case "ui_cancel":
      case "ui_answered":
        // omp closed the dialog itself (its signal aborted or its timeout passed), or another page that shows the chat
        // answered it (#2809).
        this.#requests = this.#requests.filter((open) => open.id !== event.requestId);
        return false;
      case "command_output":
        this.#notify(event.text, "output");
        return false;
      case "goal_updated":
        this.#goal = event.goal;
        return false;
      case "ui_notify":
        // An extension's or omp's notification: a status line in omp's TUI, a toast here (a long one stays as a row).
        this.#showToast(event.message, event.notifyType ?? "info");
        return false;
      case "notice": {
        // omp's out-of-band notices, as its TUI shows them: an error (the session or a side answer could not be saved)
        // stays in the transcript until dismissed; anything else passes as a toast, unless it is too long for one.
        const text = event.source ? `${event.source}: ${event.message}` : event.message;
        if (event.level === "error") this.#notify(text, "error");
        else this.#showToast(text, event.level);
        return false;
      }
      case "ui_open_url":
        this.#signIn = {
          url: event.url,
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
      case "pause_changed":
        this.#pausedAt = event.pausedAt;
        if (event.pausedAt === null) this.#held = [];
        return false;
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
    this.#beyondWindow = true;
  }

  /**
   * Drops what omp drops when it retries a tool batch (its turn recovery's `toolReplayStart`): after the assistant
   * message that made the calls, their failed results and the aborted end that followed them (an assistant message
   * without calls of its own, which a stop leaves). omp then runs the calls again, so they show as running, not as
   * aborted, and their new results take the old ones' place.
   */
  #dropReplayed(calls: ReadonlySet<string>): void {
    const anchor = this.#entries.findLastIndex(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some((block) => block.type === "toolCall" && calls.has(block.id)),
    );
    if (anchor < 0) return;
    const dropped = (entry: SessionEntry): boolean => {
      if (entry.type !== "message") return false;
      const message = entry.message;
      if (message.role === "toolResult") return calls.has(message.toolCallId);
      return (
        message.role === "assistant" &&
        (message.stopReason === "aborted" || message.stopReason === "error") &&
        !message.content.some((block) => block.type === "toolCall")
      );
    };
    const kept = this.#entries.filter((entry, index) => index <= anchor || !dropped(entry));
    if (kept.length === this.#entries.length) return;
    for (const entry of this.#entries.slice(anchor + 1)) {
      if (!dropped(entry)) continue;
      const key = messageKey(entry);
      if (key !== null) this.#keys.delete(key);
    }
    this.#entries = kept;
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
      jobs: this.#jobs,
      working: this.#working,
      pausedAt: this.#pausedAt,
      held: this.#held,
      continuesAt: this.#continuesAt,
      usagePause: this.#usagePause,
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
      toast: this.#toast,
      agents: this.#agentList,
      todos: this.#todos,
      planMode: this.#planMode,
      proposal: this.#proposal,
      goal: this.#goal,
      signIn: this.#signIn,
      role: this.#role,
      roleTrack: this.#roleTrack,
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
