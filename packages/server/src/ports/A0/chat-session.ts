/**
 * A0's runtime for chats on the chat host (SDK plan H5.3, `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.3 design"): one chat
 * host process per chat, the protocol's requests and events, and the duties A0's RPC runtime had until H5.6b removed it.
 * H5.3a has the core:
 * - opening a chat: new, resumed from its file, the folder's newest (`--continue`), with a picked model;
 * - requests;
 * - the chat's stream;
 * - viewers per connection;
 * - the registry's busy and settled marks;
 * - restart, and the repair before a request.
 * H5.3b adds the host's requests (dialogs, approvals, tools, URIs) and the host registrations; H5.3c the arbitration,
 * `!` and `$` runs, and session switches; H5.3d rename and the reopen after a refused delete.
 */
import { join } from "node:path";
import {
  type AbortSignalLike,
  type AnswerHostRequestArgs,
  type AppError,
  AppFailure,
  type ChatOpenResult,
  type ChatRequestArgs,
  type ChatSessionEvent,
  ChatSessionPort,
  chatSessionEventStream,
  type FolderPath,
  isUiStateEvent,
  type ModelChoice,
  type OpenHostRequests,
  type OpenThreadArgs,
  RequestId,
  SessionFilePath,
  type SessionRenameArgs,
  type SetEventOptionsArgs,
  type SetEventOptionsResult,
  type SetSubagentSubscriptionArgs,
  type SetSubagentSubscriptionResult,
  type StreamKey,
  type SubscribeArgs,
  ThreadId,
  type UiState,
  type UiStateEvent,
} from "@omp-app/contracts";
import {
  type ChatEvent,
  type ChatHostMethod,
  type ChatHostMethodMap,
  HOST_METHOD_ANSWERS,
  type HostRequest,
  type HostToolDefinition,
  type HostUriSchemeDefinition,
  type PromptResultEvent,
  parseChatHostParams,
  type ShellRunResult,
} from "@omp-app/contracts/chat-host";
import { z } from "zod";
import { ChatHostClient, ChatHostRequestError } from "../../chat-host/client";
import {
  type CommandPromptFuture,
  type CommandPromptOutcome,
  type CommandSession,
  type CommandSessionEvent,
  withAdmission,
} from "../../modules/A1/gateway/command-session";
import type { OmpProcess, OmpProcessOptions } from "../../process";
import type { PortHandler, PortHandlerContext } from "../../registry/ports";
import type { A0PortContext, ThreadBootstrap } from "./context";
import { modelUnavailableFailure, savedModelFromOmpText } from "./model-restore";
import { startupReason } from "./startup-reason";

interface ChatEntry {
  bootstrap: ThreadBootstrap;
  process: OmpProcess;
  client: ChatHostClient;
  stream: StreamKey;
  unsubscribe: () => void;
  /** Views per connection: what its opens took, less what its closes let go. */
  readonly viewers: Map<string, number>;
  /** Events before the chat's own id is known (`#rekey`); published once it is. */
  readonly startupEvents: ChatSessionEvent[];
  rekeyed: boolean;
  /** The methods the chat's host answers (`hello.methods`). */
  methods: readonly string[];
  /** When the chat's current process started: an entry written before it belongs to an earlier process. */
  startedAt: number;
  /** Set while the chat's process is being started again; everyone who needs it waits on it. */
  respawning?: Promise<void>;
  /** The host's requests waiting for the browser's answer: omp reports none of them once answered. */
  readonly openRequests: Map<string, OpenRequest>;
  /** The UI state omp sends once (statuses, widgets, the title), by key, with the sequence that set it. */
  readonly uiState: Map<string, { readonly seq: number; readonly event: UiStateEvent }>;
  /** The app's tools and URI schemes, per connection and owner; the host gets them merged into one set. */
  hostTools: Registrations<HostToolDefinition>;
  hostUriSchemes: Registrations<HostUriSchemeDefinition>;
  /** Registrations are written one after another. */
  hostRegistrations: Promise<void>;
  /** The app turned omp's ask dialog on; a replaced process is told again. */
  askDialogOptedIn: boolean;
  /** Each connection's subagent level and message updates; the chat's host gets them as one (`#arbitrate`). */
  readonly preferences: Map<string, Preference>;
  /** What the chat's host was told; undefined until it is, and again once its process is replaced. */
  appliedLevel?: SubagentLevel;
  appliedMessageUpdates?: MessageUpdates;
  /** Arbitrations run one after another. */
  arbitration: Promise<void>;
  /** What the server itself watches on the chat's stream (the A1 gateway's commands): told every payload published. */
  readonly payloadListeners: Set<(payload: ChatSessionEvent) => void>;
}

type SubagentLevel = SetSubagentSubscriptionArgs["level"];
type MessageUpdates = SetEventOptionsArgs["messageUpdates"];

interface Preference {
  readonly level: SubagentLevel;
  readonly messageUpdates?: MessageUpdates;
}

const LEVEL_RANK: Readonly<Record<SubagentLevel, number>> = { off: 0, progress: 1, events: 2 };

/** The methods that move the chat to another session; omp's own id for the chat changes with them. */
const SESSION_SWITCH_METHODS: ReadonlySet<ChatHostMethod> = new Set([
  "new_session",
  "branch",
  "fork",
]);

/** One kind of host registration: per connection, then per owner. */
type Registrations<T> = ReadonlyMap<string, ReadonlyMap<string, readonly T[]>>;

interface OpenRequest {
  readonly request: HostRequest;
  /** The sequence of the event that asked it, once published. */
  seq?: number;
  readonly resolve: (answer: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** The registrations with one owner's set replaced. */
function withOwner<T>(
  registrations: Registrations<T>,
  connectionId: string,
  owner: string,
  items: readonly T[],
): Registrations<T> {
  const next = new Map(registrations);
  const owners = new Map(next.get(connectionId) ?? []);
  owners.set(owner, items);
  next.set(connectionId, owners);
  return next;
}

/** Every owner's items in one set: a later owner's item replaces an earlier one's of the same key. */
function merged<T>(registrations: Registrations<T>, key: (item: T) => string): T[] {
  const all = new Map<string, T>();
  for (const owners of registrations.values()) {
    for (const items of owners.values()) {
      for (const item of items) all.set(key(item), item);
    }
  }
  return [...all.values()];
}

const toolName = (tool: HostToolDefinition): string => tool.name;
/** The host names schemes in lower case. */
const schemeName = (scheme: HostUriSchemeDefinition): string => scheme.scheme.toLowerCase();

/** The key a UI state event replaces: a status or a widget by its key, the title alone. */
function uiStateKey(event: UiStateEvent): string {
  switch (event.type) {
    case "ui_status":
      return `status:${event.statusKey}`;
    case "ui_widget":
      return `widget:${event.widgetKey}`;
    case "ui_title":
      return "title";
  }
}

/** omp clears a status or a widget by sending it with no text or lines. */
function clearsUiState(event: UiStateEvent): boolean {
  if (event.type === "ui_status") return !event.statusText;
  if (event.type === "ui_widget") return !event.widgetLines?.length;
  return false;
}

/** The arguments that open a chat with a model the person picked: omp's `--model`, as `provider/modelId`. */
function modelArgs(model: ModelChoice | undefined): string[] {
  return model === undefined ? [] : ["--model", `${model.provider}/${model.modelId}`];
}

function notFound(message: string): AppFailure {
  return new AppFailure({ code: "not_found", message, retryable: false });
}

function cancelled(message: string): AppFailure {
  return new AppFailure({ code: "cancelled", message, retryable: false });
}

function unavailable(message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: true });
}

/** A chat event the A1 gateway reads, as plain data; undefined for any other event. */
function commandEvent(event: ChatEvent): CommandSessionEvent | undefined {
  switch (event.type) {
    case "command_output":
      return { type: "command_output", text: event.text };
    case "session_info_update":
      return {
        type: "session_info_update",
        sessionId: event.sessionId,
        ...(event.title === null ? {} : { title: event.title }),
      };
    case "config_update":
      return {
        type: "config_update",
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.thinkingLevel === undefined ? {} : { thinkingLevel: event.thinkingLevel }),
      };
    case "session_settled":
      return { type: "session_settled" };
    default:
      return undefined;
  }
}

/** A chat whose process ended before its host's hello: a failed start, in the words omp's RPC port used. */
function failedStart(): AppError {
  return {
    code: "omp_exited",
    message: "omp stopped while it was starting. Try again.",
    retryable: true,
  };
}

/** A chat another tab or window of this app holds open: said in plain words, not in the registry's own text. */
function chatOpenElsewhere(cause?: unknown): AppFailure {
  return new AppFailure(
    {
      code: "conflict",
      message:
        "This chat is already open in another tab or window. Close it there, then try again.",
      retryable: true,
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * The port's failure for a host's refusal. The host's own code stays in `omp.code`, so a page can tell plan mode's
 * refusals and the busy session apart; a host that ended reads as omp's exit, which a retry can mend.
 */
function requestFailure(method: string, error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  if (!(error instanceof ChatHostRequestError)) {
    return new AppFailure({
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  }
  const omp = { command: method, error: error.message, code: error.code };
  switch (error.code) {
    case "closed":
      return new AppFailure({
        code: "omp_exited",
        message: "omp stopped before it answered. Try again.",
        retryable: true,
        omp,
      });
    case "invalid_params":
    case "unknown_method":
      return new AppFailure({
        code: "invalid_args",
        message: error.message,
        retryable: false,
        omp,
      });
    case "agent_busy":
      // The words A0's RPC port used for omp's refusal: plain words, never omp's own text.
      return new AppFailure({
        code: "agent_busy",
        message: "omp is still working on something.",
        retryable: true,
        omp,
      });
    case "session_busy":
    case "stale_cursor":
    case "unknown_since":
      return new AppFailure({ code: "conflict", message: error.message, retryable: true, omp });
    default:
      return new AppFailure({ code: "omp_error", message: error.message, retryable: false, omp });
  }
}

/** A0's stateful bridge between the chat session port and one chat host process per chat. */
export class ChatSessionPortRuntime {
  readonly #context: A0PortContext;
  readonly #entries = new Map<ThreadId, ChatEntry>();
  /** A chat's earlier ids, after a session switch moved it: each names the id it moved to. */
  readonly #aliases = new Map<ThreadId, ThreadId>();
  /** The connections a refused delete's chat is opening again for, until that open ends: `closed` once they close. */
  readonly #pendingReopens = new Map<string, { closed: boolean }>();
  /** The renames of each chat, one after another: a second rename waits for the first to finish. */
  readonly #renames = new Map<ThreadId, Promise<void>>();
  /** Chats whose process is starting and whose host has not said hello yet: an exit now is a failed start. */
  readonly #awaitingHello = new Set<ChatEntry>();

  constructor(context: A0PortContext) {
    this.#context = context;
    context.processRegistry.setIdleHooks({
      isSettled: (threadId) => this.#isSettled(threadId),
      stopped: (threadId, process, refusedDelete) =>
        this.#forgetStopped(threadId, process, refusedDelete),
    });
  }

  readonly handlers: Readonly<Record<string, PortHandler>> = {
    // The dispatcher parses each method's zod args before invoking this boundary.
    open: (args, call) => this.open(args as OpenThreadArgs, call),
    request: (args, call) => this.request(args as ChatRequestArgs, call),
    subscribe: (args) => this.subscribe(args as SubscribeArgs),
    restart: (args) => this.restart(args as { threadId: ThreadId }),
    close: (args, call) => this.close(args as { threadId: ThreadId }, call),
    rename: (args, call) => this.rename(args as SessionRenameArgs, call),
    answer: (args) => this.answer(args as AnswerHostRequestArgs),
    openRequests: (args) => this.openRequests(args as { threadId: ThreadId }),
    uiState: (args) => this.uiState(args as { threadId: ThreadId }),
    setSubagentSubscription: (args, call) =>
      this.setSubagentSubscription(args as SetSubagentSubscriptionArgs, call),
    setEventOptions: (args, call) => this.setEventOptions(args as SetEventOptionsArgs, call),
  };

  /** The session file an open chat runs, known before omp writes it (a new chat writes its file after its first reply). */
  sessionFileOf(threadId: ThreadId): SessionFilePath | undefined {
    return this.#entryOrUndefined(threadId)?.bootstrap.sessionFile;
  }

  /**
   * The chat as a command session for the A1 gateway; undefined for a chat no host here serves. Its events follow the
   * chat across a restart and a session switch.
   */
  commandSessionFor(threadId: ThreadId): CommandSession | undefined {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || this.#context.processRegistry.isStopping(entry.bootstrap.threadId)) {
      return undefined;
    }
    return {
      availableCommands: async () => {
        await this.#ensureRunning(entry);
        return (await this.#send(entry, "get_available_commands", {})).commands;
      },
      prompt: (text, signal) => this.#commandPrompt(entry, text, signal),
      onEvent: (listener) =>
        this.#watchPayloads(entry, (payload) => {
          const event = payload.kind === "event" ? commandEvent(payload.event) : undefined;
          if (event !== undefined) listener(event);
        }),
    };
  }

  async open(args: OpenThreadArgs, call: PortHandlerContext): Promise<ChatOpenResult> {
    const registry = this.#context.processRegistry;
    if (this.#context.health.status !== "ok") {
      throw new AppFailure({
        code: "unavailable",
        message: this.#context.health.detail ?? "omp is unavailable",
        retryable: true,
      });
    }
    // A chat whose process is stopping keeps its entry with the bootstrap of its first start: the stop is waited for
    // first, so the open resumes the chat's file (issue 2212).
    if ("threadId" in args) await registry.whenGone(args.threadId, "opened");
    const bootstrap = await this.#resolveBootstrap(args, call.signal);
    await registry.whenGone(bootstrap.threadId, "opened");
    // A connection that closed while this open waited released its views before this one was added; nothing awaits
    // between this check and the view, so an open that passes it is released by its connection's close.
    if (call.signal.aborted) throw cancelled("Opening the chat was cancelled.");
    const existing = this.#entries.get(bootstrap.threadId);
    if (existing !== undefined) {
      if (existing.bootstrap.folderPath !== bootstrap.folderPath) {
        throw new AppFailure({
          code: "conflict",
          message: "The thread is already open in a different folder",
          retryable: false,
        });
      }
      registry.acquire(this.#processOptions(bootstrap));
      this.#addViewer(existing, call.connectionId);
      return this.#openResult(existing);
    }

    await this.#refuseChatHeldElsewhere(bootstrap);
    const process = registry.acquire(this.#processOptions(bootstrap));
    const entry: ChatEntry = {
      bootstrap,
      process,
      client: new ChatHostClient(process),
      stream: chatSessionEventStream(bootstrap.threadId),
      unsubscribe: () => undefined,
      viewers: new Map(),
      startupEvents: [],
      rekeyed: false,
      methods: [],
      startedAt: Date.now(),
      openRequests: new Map(),
      uiState: new Map(),
      hostTools: new Map(),
      hostUriSchemes: new Map(),
      hostRegistrations: Promise.resolve(),
      askDialogOptedIn: false,
      preferences: new Map(),
      arbitration: Promise.resolve(),
      payloadListeners: new Set(),
    };
    entry.unsubscribe = this.#listen(entry);
    this.#entries.set(bootstrap.threadId, entry);
    this.#addViewer(entry, call.connectionId);
    try {
      await this.#start(entry);
      // A newer pick superseded this open while the chat started: the open ends here, and the catch lets its view go.
      if (call.signal.aborted) throw cancelled("Opening the chat was cancelled.");
      let identity = await this.#identity(entry);
      if ("start" in args && args.start === "new" && identity.messageCount > 0) {
        // A new chat starts without --continue, but omp's auto-resume can still restore the folder's newest one. Its
        // startup events are dropped before the new session, so New chat never shows the old transcript.
        entry.startupEvents.length = 0;
        const result = await entry.client.request("new_session", {});
        if (result.cancelled) throw cancelled("Starting a new chat was cancelled.");
        identity = await this.#identity(entry);
      }
      this.#rekey(entry, "threadId" in args ? args.threadId : undefined, identity);
    } catch (error) {
      // A cancelled open leaves a chat another view still watches running: only this open's view goes.
      const otherViews = [...entry.viewers].reduce(
        (sum, [id, count]) => sum + (id === call.connectionId ? count - 1 : count),
        0,
      );
      if (call.signal.aborted && otherViews > 0) {
        this.#releaseView(entry, call.connectionId);
        throw error;
      }
      entry.client.dispose();
      this.#dropEntry(entry);
      // The failed process is stopped and forgotten: the next open starts the chat again. A stop that fails is logged
      // where it happens; the open's own failure is what the caller hears.
      await registry.stopIfUnwatched(entry.bootstrap.threadId, "opened").catch(() => undefined);
      const failure = requestFailure("open", error);
      if (failure.appError.code === "omp_exited") {
        // The chat stopped before it was ready, and its last words say why: a saved model it could not restore offers
        // another model; any other reason reaches the browser as a typed reason.
        await process.stderrSettled?.();
        const savedModel = savedModelFromOmpText(process.stderrTail);
        if (savedModel !== undefined) throw modelUnavailableFailure(savedModel);
        if ("threadId" in args) throw notFound(failure.appError.message);
        throw new AppFailure({ ...failure.appError, startup: startupReason(process.stderrTail) });
      }
      throw failure;
    }
    return this.#openResult(entry);
  }

  /**
   * A request by a method's name: its params are checked against the method before the host sees them. A host tool or
   * URI scheme registration is merged with every other owner's; only a viewer of the chat may make one.
   */
  async request(args: ChatRequestArgs, call: PortHandlerContext): Promise<unknown> {
    // A chat no host here serves may still be open in another omp: the request is refused with the sentence that says so.
    if (this.#entryOrUndefined(args.threadId) === undefined) {
      await this.#refuseWhenHeldElsewhere(args.threadId, call.signal);
    }
    const entry = this.#entry(args.threadId);
    await this.#ensureRunning(entry);
    // A call the browser gave up while its chat started again reaches no host: the browser was told it was cancelled,
    // as omp's RPC port refused a cancelled command before writing it.
    if (call.signal.aborted) throw cancelled("The command was cancelled.");
    const method = args.method as ChatHostMethod;
    const params = parseChatHostParams(method, args.params);
    if (!params.ok) {
      throw new AppFailure({
        code: "invalid_args",
        message: params.error.message,
        retryable: false,
      });
    }
    if (method === "set_host_tools" || method === "set_host_uri_schemes") {
      const owner = args.registrationOwner;
      if (owner === undefined) {
        throw new AppFailure({
          code: "invalid_args",
          message: "A host registration owner is required.",
          retryable: false,
        });
      }
      this.#requireViewer(entry, call.connectionId);
      return method === "set_host_tools"
        ? this.#registerTools(
            entry,
            call.connectionId,
            owner,
            (params.value as ChatHostMethodMap["set_host_tools"]["params"]).tools,
          )
        : this.#registerUriSchemes(
            entry,
            call.connectionId,
            owner,
            (params.value as ChatHostMethodMap["set_host_uri_schemes"]["params"]).schemes,
          );
    }
    // omp reports a `!` or `$` run only to its caller: every viewer hears it start and end.
    if (method === "bash" || method === "python") {
      return this.#shellRun(
        entry,
        method,
        params.value as ChatHostMethodMap[typeof method]["params"],
      );
    }
    const result = await this.#send(
      entry,
      method,
      params.value as ChatHostMethodMap[typeof method]["params"],
    );
    // The opt-in lasts for one process: a replaced one is told again (`#reapply`).
    if (method === "set_ask_dialog") {
      entry.askDialogOptedIn = (
        params.value as ChatHostMethodMap["set_ask_dialog"]["params"]
      ).enabled;
    }
    if (SESSION_SWITCH_METHODS.has(method)) await this.#refreshIdentity(entry);
    return result;
  }

  /** One connection's subagent level: the chat's host gets the highest of its viewers'. */
  async setSubagentSubscription(
    args: SetSubagentSubscriptionArgs,
    call: PortHandlerContext,
  ): Promise<SetSubagentSubscriptionResult> {
    const entry = this.#entry(args.threadId);
    await this.#ensureRunning(entry);
    entry.preferences.set(call.connectionId, {
      ...this.#preference(entry, call.connectionId),
      level: args.level,
    });
    await this.#arbitrate(entry);
    return { level: entry.appliedLevel ?? "off" };
  }

  /** One connection's message updates: the chat's host gets `full` when any viewer asks for it, else `delta`. */
  async setEventOptions(
    args: SetEventOptionsArgs,
    call: PortHandlerContext,
  ): Promise<SetEventOptionsResult> {
    const entry = this.#entry(args.threadId);
    await this.#ensureRunning(entry);
    entry.preferences.set(call.connectionId, {
      ...this.#preference(entry, call.connectionId),
      messageUpdates: args.messageUpdates,
    });
    await this.#arbitrate(entry);
    return entry.appliedMessageUpdates === undefined
      ? {}
      : { messageUpdates: entry.appliedMessageUpdates };
  }

  /**
   * Renames a chat. An open chat is renamed by its own host. A chat nobody has open, or whose host is stopping, is
   * renamed by a short-lived host: opened, checked for another omp's lease, asked to set the name, and stopped again at
   * once, whatever the outcome.
   */
  async rename(args: SessionRenameArgs, call: PortHandlerContext): Promise<null> {
    await this.#serializeRename(args.threadId, async () => {
      const entry = this.#entryOrUndefined(args.threadId);
      // A chat whose host is stopping is renamed as a closed one: the rename waits for that host to exit and writes
      // nothing into it. The wait is keyed by the entry's own id, since no stop is keyed by a switched chat's old id.
      if (
        entry === undefined ||
        this.#context.processRegistry.isStopping(entry.bootstrap.threadId)
      ) {
        await this.#renameClosed(
          { ...args, threadId: entry?.bootstrap.threadId ?? args.threadId },
          call,
        );
        return;
      }
      await this.#ensureRunning(entry);
      await this.#send(entry, "set_session_name", { name: args.name });
    });
    return null;
  }

  async #renameClosed(args: SessionRenameArgs, call: PortHandlerContext): Promise<void> {
    const resolved = await this.#context.resolveThread(args.threadId, call.signal);
    if (resolved === undefined) throw notFound(`Thread ${args.threadId} was not found`);
    // A host this server is still stopping holds the chat's file until it exits.
    await this.#context.processRegistry.whenGone(args.threadId, "renamed");
    const opened = await this.open({ threadId: args.threadId }, call);
    try {
      // Checked once this host is up and before it writes. omp takes a chat's lease only when it writes, so another omp
      // that has written the chat shows up here, and a refusal leaves the chat as it was.
      const hostPid = this.#context.processRegistry.get(args.threadId)?.pid;
      const other = await this.#context.externalOmp(args.threadId, opened.sessionFile, hostPid);
      if (other === "running") {
        throw new AppFailure({
          code: "conflict",
          message:
            "Another omp is using this chat, so it can't be renamed right now. Close that omp, then try again.",
          retryable: true,
        });
      }
      if (other === "unknown") {
        throw unavailable(
          "The app can't tell whether another omp is using this chat, so nothing was renamed.",
        );
      }
      const entry = this.#entry(args.threadId);
      await this.#send(entry, "set_session_name", { name: args.name });
      // Another omp can start writing between the check and this write; omp then moves the chat to a copy.
      const identity = await this.#identity(entry);
      if (identity.threadId !== args.threadId || identity.sessionFile !== opened.sessionFile) {
        throw new AppFailure({
          code: "conflict",
          message:
            "Another omp started writing this chat during the rename, so the new title went to a copy. The original keeps its old title, and the copy is listed as its own chat.",
          retryable: false,
        });
      }
    } finally {
      await this.close({ threadId: args.threadId }, call);
      // A stop that fails is logged where it happens. The rename does not fail for its host's stop, and the next open or
      // delete waits for the host to be gone.
      await this.#context.processRegistry
        .stopIfUnwatched(args.threadId, "renamed")
        .catch(() => undefined);
    }
  }

  #serializeRename(threadId: ThreadId, operation: () => Promise<void>): Promise<void> {
    const previous = this.#renames.get(threadId) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#renames.set(threadId, settled);
    void settled.then(() => {
      if (this.#renames.get(threadId) === settled) this.#renames.delete(threadId);
    });
    return current;
  }

  /** The browser's answer to a host request, checked against the request's method before the host gets it. */
  answer(args: AnswerHostRequestArgs): null {
    const entry = this.#entry(args.threadId);
    const open = entry.openRequests.get(args.id);
    if (open === undefined) {
      throw notFound(
        "Nothing waits for that answer: the request was answered, given up, or its chat restarted.",
      );
    }
    const answer = HOST_METHOD_ANSWERS[open.request.method].safeParse(args.answer);
    if (!answer.success) {
      throw new AppFailure({
        code: "invalid_args",
        message: `The answer does not fit ${open.request.method}: ${z.prettifyError(answer.error)}`,
        retryable: false,
      });
    }
    entry.openRequests.delete(args.id);
    open.resolve(answer.data);
    return null;
  }

  /** The host requests still waiting, oldest first: a page that opens the chat again shows them. */
  openRequests(args: { threadId: ThreadId }): OpenHostRequests {
    const open: OpenHostRequests = [];
    for (const { request, seq } of this.#entry(args.threadId).openRequests.values()) {
      if (seq !== undefined) open.push({ seq, request });
    }
    return open.sort((left, right) => left.seq - right.seq);
  }

  /** The UI state the chat holds (statuses, widgets, the title), oldest first. */
  uiState(args: { threadId: ThreadId }): UiState {
    return [...this.#entry(args.threadId).uiState.values()].sort(
      (left, right) => left.seq - right.seq,
    );
  }

  subscribe(args: SubscribeArgs): { stream: StreamKey } {
    return { stream: this.#entry(args.threadId).stream };
  }

  /** Starts the chat's process again, resumed from its file; a running process is stopped first, ending its turn. */
  async restart(args: { threadId: ThreadId }): Promise<null> {
    await this.#startRespawn(this.#entry(args.threadId));
    return null;
  }

  async close(args: { threadId: ThreadId }, call: PortHandlerContext): Promise<null> {
    const entry = this.#entryOrUndefined(args.threadId);
    if (entry === undefined) return null;
    const viewed = (entry.viewers.get(call.connectionId) ?? 0) > 0;
    this.#releaseView(entry, call.connectionId);
    if (!viewed) return null;
    entry.preferences.delete(call.connectionId);
    // The connection's last view of the chat takes its tools and URI schemes with it.
    if (!entry.viewers.has(call.connectionId)) {
      await this.#releaseRegistrations(entry, call.connectionId);
    }
    // Only a chat others still watch is told the viewers' preferences again: the last view leaving tells the host nothing.
    if (entry.viewers.size > 0) await this.#arbitrateQuietly(entry);
    return null;
  }

  /**
   * A browser connection closed (a tab closed or reloaded, the network lost): every view it held is released, as if it
   * had closed each one, with its tools, URI schemes and preferences. A process nobody watches is stopped by the
   * registry after its idle time, unless it is working.
   */
  async releaseConnection(connectionId: string): Promise<void> {
    // A refused delete's chat opening again for this connection gives it no view back.
    const pending = this.#pendingReopens.get(connectionId);
    if (pending !== undefined) pending.closed = true;
    const stillWatched: ChatEntry[] = [];
    for (const entry of [...new Set(this.#entries.values())]) {
      const count = entry.viewers.get(connectionId) ?? 0;
      if (count === 0) continue;
      entry.viewers.delete(connectionId);
      entry.preferences.delete(connectionId);
      for (let view = 0; view < count; view += 1) {
        this.#context.processRegistry.release(entry.bootstrap.threadId);
      }
      await this.#releaseRegistrations(entry, connectionId);
      if (entry.viewers.size > 0) stillWatched.push(entry);
    }
    await Promise.all(stillWatched.map((entry) => this.#arbitrateQuietly(entry)));
  }

  /** How many views one connection holds on a chat. */
  viewsOf(threadId: ThreadId, connectionId: string): number {
    return this.#entryOrUndefined(threadId)?.viewers.get(connectionId) ?? 0;
  }

  /** How many views every connection holds on a chat together: the count the chat's process is watched by. */
  watcherCount(threadId: ThreadId): number {
    let total = 0;
    for (const count of this.#entryOrUndefined(threadId)?.viewers.values() ?? []) total += count;
    return total;
  }

  /** Lets go of every view one connection holds on a chat, as deleting the chat does; other connections keep theirs. */
  async releaseViews(threadId: ThreadId, connectionId: string): Promise<void> {
    const entry = this.#entryOrUndefined(threadId);
    const count = entry?.viewers.get(connectionId) ?? 0;
    if (entry === undefined || count === 0) return;
    entry.viewers.delete(connectionId);
    entry.preferences.delete(connectionId);
    for (let view = 0; view < count; view += 1) {
      this.#context.processRegistry.release(entry.bootstrap.threadId);
    }
    await this.#releaseRegistrations(entry, connectionId);
    if (entry.viewers.size > 0) await this.#arbitrateQuietly(entry);
  }

  /**
   * Gives a connection back the views a delete's stop took from it, joined to the chat's running process. A chat no
   * running process serves gets nothing: no process starts for it.
   */
  restoreViews(threadId: ThreadId, connectionId: string, count: number): void {
    const entry = this.#entryOrUndefined(threadId);
    const registry = this.#context.processRegistry;
    if (entry === undefined || !registry.has(entry.bootstrap.threadId)) return;
    if (registry.isStopping(entry.bootstrap.threadId)) return;
    const missing = count - (entry.viewers.get(connectionId) ?? 0);
    for (let view = 0; view < missing; view += 1) {
      registry.acquire(this.#processOptions(entry.bootstrap));
      this.#addViewer(entry, connectionId);
    }
  }

  async dispose(): Promise<void> {
    for (const entry of new Set(this.#entries.values())) {
      entry.unsubscribe();
      entry.client.dispose();
    }
    this.#entries.clear();
    this.#aliases.clear();
    await this.#context.processRegistry.closeAll();
  }

  /** Starts the chat's process and waits for its host's hello. */
  async #start(entry: ChatEntry): Promise<void> {
    this.#awaitingHello.add(entry);
    let hello: Awaited<ChatHostClient["hello"]>;
    try {
      await entry.process.start();
      try {
        hello = await entry.client.hello;
      } catch {
        throw new AppFailure(failedStart());
      }
    } finally {
      this.#awaitingHello.delete(entry);
    }
    entry.methods = hello.methods;
    this.#receive(entry, { kind: "process", status: "ready", startedAt: entry.startedAt });
  }

  /** The host's events, its requests and the process's life, into the chat's stream. */
  #listen(entry: ChatEntry): () => void {
    const fromHost = entry.client.onEvent((event) =>
      this.#receive(entry, { kind: "event", event }),
    );
    entry.client.onRequest((request) => this.#hostRequest(entry, request));
    const fromProcess = entry.process.onEvent((event) => {
      // A process that ends before its host's hello is a failed start: the chat says so in the start's words, as omp's
      // RPC port did, not with the exit's code or signal.
      const error =
        event.error !== undefined && this.#awaitingHello.has(entry) ? failedStart() : event.error;
      this.#receive(entry, {
        kind: "process",
        status: event.status,
        startedAt: entry.startedAt,
        ...(error === undefined ? {} : { error }),
      });
    });
    return () => {
      fromHost();
      fromProcess();
    };
  }

  #receive(entry: ChatEntry, payload: ChatSessionEvent): void {
    // The events of a process that is stopping, its exit among them, reach no viewer and no replay.
    if (this.#context.processRegistry.isStopping(entry.bootstrap.threadId)) return;
    if (payload.kind === "event") this.#trackTurn(entry.bootstrap.threadId, payload.event);
    if (!entry.rekeyed) {
      entry.startupEvents.push(payload);
      return;
    }
    this.#publish(entry, payload);
  }

  /** Publishes on the chat's stream, and keeps the open requests and the UI state in step with what was published. */
  #publish(entry: ChatEntry, payload: ChatSessionEvent): void {
    const { seq } = this.#context.replay.publish(entry.stream, payload);
    for (const listener of [...entry.payloadListeners]) listener(payload);
    if (payload.kind === "host_request") {
      const open = entry.openRequests.get(payload.request.id);
      if (open !== undefined) open.seq = seq;
      return;
    }
    if (payload.kind === "process") {
      // A process that has ended can take no answer.
      if (payload.status === "exited" || payload.status === "error") this.#closeRequests(entry);
      return;
    }
    if (payload.kind !== "event") return;
    const { event } = payload;
    if (event.type === "ui_cancel" || event.type === "tool_cancel" || event.type === "uri_cancel") {
      this.#closeRequest(entry, event.requestId);
    } else if (isUiStateEvent(event)) {
      if (clearsUiState(event)) entry.uiState.delete(uiStateKey(event));
      else entry.uiState.set(uiStateKey(event), { seq, event });
    }
  }

  /** A host request waits in the open requests until the browser answers it or the host gives it up. */
  #hostRequest(entry: ChatEntry, request: HostRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      entry.openRequests.set(request.id, { request, resolve, reject });
      this.#receive(entry, { kind: "host_request", request });
    });
  }

  /** The host gave a request up (omp's abort or timeout, or the process ended): an answer would reach nothing. */
  #closeRequest(entry: ChatEntry, id: string): void {
    const open = entry.openRequests.get(id);
    if (open === undefined) return;
    entry.openRequests.delete(id);
    open.reject(new Error("The chat no longer waits for this answer."));
  }

  #closeRequests(entry: ChatEntry): void {
    for (const id of [...entry.openRequests.keys()]) this.#closeRequest(entry, id);
  }

  /**
   * Keeps the registry's busy mark in step with the chat: busy from `agent_start` until the session settles
   * (`session_settled`, or a `prompt_result` that reports it settled). A yielded run is not a settled session.
   */
  #trackTurn(threadId: ThreadId, event: ChatEvent): void {
    if (event.type === "agent_start") {
      this.#context.processRegistry.setBusy(threadId, true);
    } else if (
      event.type === "session_settled" ||
      (event.type === "prompt_result" && event.sessionSettled)
    ) {
      this.#context.processRegistry.setBusy(threadId, false);
    }
  }

  /** The chat's own id and file, from its state. */
  async #identity(
    entry: ChatEntry,
  ): Promise<{ threadId: ThreadId; sessionFile: SessionFilePath; messageCount: number }> {
    const state = await entry.client.request("get_state", {});
    if (state.sessionFile === undefined) {
      throw new AppFailure({
        code: "omp_error",
        message: "The chat opened without a session file.",
        retryable: false,
      });
    }
    return {
      threadId: ThreadId.parse(state.sessionId),
      sessionFile: SessionFilePath.parse(state.sessionFile),
      messageCount: state.messageCount,
    };
  }

  /** Moves the chat from its provisional id to its own, then publishes the events that waited for it. */
  #rekey(
    entry: ChatEntry,
    requestedThreadId: ThreadId | undefined,
    identity: { threadId: ThreadId; sessionFile: SessionFilePath },
  ): void {
    if (
      requestedThreadId !== undefined &&
      (identity.threadId !== requestedThreadId ||
        identity.sessionFile !== entry.bootstrap.sessionFile)
    ) {
      throw new AppFailure({
        code: "conflict",
        message: "The chat opened as a different chat than the one asked for. Try again.",
        retryable: false,
      });
    }
    this.#moveProcess(entry.bootstrap.threadId, identity.threadId);
    const provisional = entry.bootstrap.threadId;
    this.#entries.delete(provisional);
    entry.bootstrap = {
      ...entry.bootstrap,
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    };
    entry.stream = chatSessionEventStream(identity.threadId);
    this.#entries.set(identity.threadId, entry);
    entry.rekeyed = true;
    for (const payload of entry.startupEvents.splice(0)) {
      this.#publish(entry, payload);
    }
  }

  async #resolveBootstrap(args: OpenThreadArgs, signal: AbortSignalLike): Promise<ThreadBootstrap> {
    if ("threadId" in args) {
      const existing = this.#entries.get(args.threadId);
      if (existing !== undefined) return existing.bootstrap;
      const resolved = await this.#context.resolveThread(args.threadId, signal);
      if (resolved === undefined) throw notFound(`Thread ${args.threadId} was not found`);
      if (!(await this.#hasSessionFile(resolved.sessionFile))) {
        throw notFound(`Session file not found: ${resolved.sessionFile}`);
      }
      return {
        ...resolved,
        args: ["--resume", resolved.sessionFile, ...modelArgs(args.model)],
        ...(args.model === undefined ? {} : { model: args.model }),
      };
    }
    if (args.start === "new") return this.#provisionalBootstrap(args.folderPath, []);
    // omp's --continue opens the folder's newest chat but says which only once it runs, when it has begun to write it.
    // So the chat is found first: one this server already runs is refused, and no process starts.
    const latest = await this.#context.latestThread(args.folderPath, signal);
    if (latest !== undefined) {
      await this.#context.processRegistry.whenGone(latest.threadId, "opened");
      if (this.#context.processRegistry.has(latest.threadId)) throw chatOpenElsewhere();
    }
    return this.#provisionalBootstrap(args.folderPath, ["--continue"]);
  }

  /** A chat before its own id is known: keyed by a provisional id that `#rekey` replaces, as A0's RPC runtime keys it. */
  #provisionalBootstrap(folderPath: FolderPath, args: readonly string[]): ThreadBootstrap {
    const threadId = ThreadId.parse(`provisional-${crypto.randomUUID()}`);
    const sessionFile = SessionFilePath.parse(join(folderPath, ".omp", `${threadId}.jsonl`));
    return { threadId, folderPath, sessionFile, args };
  }

  /**
   * Refuses a chat another omp holds, before this open starts one. A held lease no process of this app backs is a
   * terminal's: omp would load the file, then move the chat to a new id.
   */
  async #refuseChatHeldElsewhere(bootstrap: ThreadBootstrap): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (
        entry.bootstrap.sessionFile === bootstrap.sessionFile &&
        this.#context.processRegistry.has(entry.bootstrap.threadId)
      ) {
        return;
      }
    }
    if ((await this.#context.leaseProbe?.(bootstrap.threadId)) !== "active") return;
    throw new AppFailure({
      code: "conflict",
      message:
        "This chat is open in another omp, for example in a terminal. Close it there, then open it here.",
      retryable: true,
      conflictReason: "held_elsewhere",
    });
  }

  /** Brings the chat's process back before a request when it stopped under the chat or its repair is under way. */
  async #ensureRunning(entry: ChatEntry): Promise<void> {
    const status = entry.process.status;
    const stopped = status === "exited" || status === "error" || status === "stopped";
    if (entry.respawning === undefined && !stopped) return;
    await this.#startRespawn(entry);
  }

  #startRespawn(entry: ChatEntry): Promise<void> {
    if (entry.respawning !== undefined) return entry.respawning;
    const attempt = this.#respawn(entry).finally(() => {
      entry.respawning = undefined;
    });
    entry.respawning = attempt;
    return attempt;
  }

  /** A new process for the chat, resumed from its file; the chat's viewers hear it on the chat's own stream. */
  async #respawn(entry: ChatEntry): Promise<void> {
    const { threadId, folderPath, sessionFile } = entry.bootstrap;
    if (!(await this.#hasSessionFile(sessionFile))) {
      throw new AppFailure({
        code: "omp_exited",
        message:
          "omp stopped before this chat was saved, so it can't be continued. Start a new chat.",
        retryable: false,
      });
    }
    const args = ["--resume", sessionFile, ...modelArgs(entry.bootstrap.model)];
    // The registry stops the old process (already gone after a crash) and keeps the chat's viewers.
    const process = await this.#context.processRegistry.respawn({
      threadId,
      folder: folderPath,
      args,
    });
    entry.unsubscribe();
    entry.client.dispose();
    // The replaced process's questions can never be answered, and its UI state goes with it.
    this.#closeRequests(entry);
    entry.uiState.clear();
    entry.appliedLevel = undefined;
    entry.appliedMessageUpdates = undefined;
    entry.bootstrap = { ...entry.bootstrap, args };
    entry.process = process;
    entry.client = new ChatHostClient(process);
    entry.startedAt = Date.now();
    entry.unsubscribe = this.#listen(entry);
    await this.#start(entry);
    await this.#reapply(entry);
    // Only what a viewer asked for is told to the new process; a chat nobody tuned keeps the host's defaults.
    if (entry.preferences.size > 0) await this.#arbitrate(entry);
  }

  /** Whether the chat's host says it has settled; a chat nothing holds counts as settled. */
  async #isSettled(threadId: ThreadId): Promise<boolean> {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined) return true;
    return (await entry.client.request("get_state", {})).isSettled;
  }

  /**
   * The registry stopped a chat's process on purpose: its entry can't serve again, so the next open starts fresh. A stop
   * that a refused delete waited on past the limit keeps the views its tabs held: the chat is opened again for them.
   */
  #forgetStopped(threadId: ThreadId, process: OmpProcess, refusedDelete: boolean): void {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || entry.process !== process) return;
    const kept = refusedDelete ? [...entry.viewers] : [];
    this.#forget(entry);
    if (kept.length > 0) void this.#reopenAfterStop(entry.bootstrap.threadId, kept);
  }

  /**
   * Opens a refused delete's chat again for the tabs that held views on it when its host stopped. The delete did not
   * remove the chat, so its file is still there. A chat another omp holds stays closed, so no host starts on a file
   * another omp writes; a tab that closes meanwhile does not get its view back.
   */
  async #reopenAfterStop(
    threadId: ThreadId,
    kept: readonly (readonly [string, number])[],
  ): Promise<void> {
    const signal = new AbortController().signal;
    const pending = new Map<string, { closed: boolean }>();
    for (const [connectionId] of kept) {
      const record = this.#pendingReopens.get(connectionId) ?? { closed: false };
      this.#pendingReopens.set(connectionId, record);
      pending.set(connectionId, record);
    }
    try {
      const resolved = await this.#context.resolveThread(threadId, signal);
      if (resolved === undefined) return;
      const other = await this.#context.externalOmp(threadId, resolved.sessionFile, undefined);
      if (other !== "none") return;
      for (const [connectionId, count] of kept) {
        // Read through a function: the record changes while an open waits.
        const closed = (): boolean => pending.get(connectionId)?.closed === true;
        for (let view = 0; view < count && !closed(); view += 1) {
          await this.open(
            { threadId },
            {
              connectionId,
              signal,
              requestId: RequestId.parse(`reopen-${threadId}`),
              portContext: undefined,
            },
          );
          if (closed()) await this.releaseViews(threadId, connectionId);
        }
      }
    } catch (error) {
      this.#context.logger?.warn("chat_session.reopen_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      for (const [connectionId, record] of pending) {
        if (this.#pendingReopens.get(connectionId) === record) {
          this.#pendingReopens.delete(connectionId);
        }
      }
    }
  }

  #forget(entry: ChatEntry): void {
    entry.unsubscribe();
    entry.client.dispose();
    this.#closeRequests(entry);
    const current = entry.bootstrap.threadId;
    this.#entries.delete(current);
    for (const [alias, target] of this.#aliases) {
      if (alias === current || target === current) this.#aliases.delete(alias);
    }
  }

  /** Forgets an entry whose open failed, and lets go of the process it acquired. */
  #dropEntry(entry: ChatEntry): void {
    this.#forget(entry);
    this.#context.processRegistry.release(entry.bootstrap.threadId);
  }

  #addViewer(entry: ChatEntry, connectionId: string): void {
    entry.viewers.set(connectionId, (entry.viewers.get(connectionId) ?? 0) + 1);
  }

  /** Lets go of one open's view of a chat: the chat's process stays for any other view. */
  #releaseView(entry: ChatEntry, connectionId: string): void {
    const count = entry.viewers.get(connectionId) ?? 0;
    if (count === 0) return;
    if (count === 1) entry.viewers.delete(connectionId);
    else entry.viewers.set(connectionId, count - 1);
    this.#context.processRegistry.release(entry.bootstrap.threadId);
  }

  /** Host registrations are released with a connection's views, so only a viewer may make one. */
  #requireViewer(entry: ChatEntry, connectionId: string): void {
    if ((entry.viewers.get(connectionId) ?? 0) > 0) return;
    throw notFound(
      "Open this chat on this connection before registering host tools or URI schemes.",
    );
  }

  async #send<M extends ChatHostMethod>(
    entry: ChatEntry,
    method: M,
    params: ChatHostMethodMap[M]["params"],
  ): Promise<ChatHostMethodMap[M]["result"]> {
    try {
      return await entry.client.request(method, params);
    } catch (error) {
      throw requestFailure(method, error);
    }
  }

  /** One registration after another, so two owners' writes cannot cross. */
  #serializeRegistrations<T>(entry: ChatEntry, operation: () => Promise<T>): Promise<T> {
    const current = entry.hostRegistrations.then(operation, operation);
    entry.hostRegistrations = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  #registerTools(
    entry: ChatEntry,
    connectionId: string,
    owner: string,
    tools: readonly HostToolDefinition[],
  ): Promise<{ toolNames: string[] }> {
    return this.#serializeRegistrations(entry, async () => {
      const next = withOwner(entry.hostTools, connectionId, owner, tools);
      const { toolNames } = await this.#send(entry, "set_host_tools", {
        tools: merged(next, toolName),
      });
      entry.hostTools = next;
      const own = new Set(tools.map(toolName));
      return { toolNames: toolNames.filter((name) => own.has(name)) };
    });
  }

  #registerUriSchemes(
    entry: ChatEntry,
    connectionId: string,
    owner: string,
    schemes: readonly HostUriSchemeDefinition[],
  ): Promise<{ schemes: string[] }> {
    return this.#serializeRegistrations(entry, async () => {
      const next = withOwner(entry.hostUriSchemes, connectionId, owner, schemes);
      const result = await this.#send(entry, "set_host_uri_schemes", {
        schemes: merged(next, schemeName),
      });
      entry.hostUriSchemes = next;
      const own = new Set(schemes.map(schemeName));
      return { schemes: result.schemes.filter((scheme) => own.has(scheme)) };
    });
  }

  /** A connection's tools and URI schemes leave the chat with its last view; a write that fails is logged. */
  #releaseRegistrations(entry: ChatEntry, connectionId: string): Promise<void> {
    return this.#serializeRegistrations(entry, async () => {
      const hadTools = entry.hostTools.has(connectionId);
      const hadSchemes = entry.hostUriSchemes.has(connectionId);
      if (!hadTools && !hadSchemes) return;
      const tools = new Map(entry.hostTools);
      tools.delete(connectionId);
      const schemes = new Map(entry.hostUriSchemes);
      schemes.delete(connectionId);
      entry.hostTools = tools;
      entry.hostUriSchemes = schemes;
      const writes: Promise<unknown>[] = [];
      if (hadTools)
        writes.push(this.#send(entry, "set_host_tools", { tools: merged(tools, toolName) }));
      if (hadSchemes) {
        writes.push(
          this.#send(entry, "set_host_uri_schemes", { schemes: merged(schemes, schemeName) }),
        );
      }
      for (const write of await Promise.allSettled(writes)) {
        if (write.status === "rejected") {
          this.#context.logger?.warn("chat_session.registrations_release_failed", {
            message: write.reason instanceof Error ? write.reason.message : String(write.reason),
          });
        }
      }
    });
  }

  /** A replaced process is told what the old one was: the app's registrations and the ask-dialog opt-in. */
  async #reapply(entry: ChatEntry): Promise<void> {
    await this.#serializeRegistrations(entry, async () => {
      if (entry.hostTools.size > 0) {
        await this.#send(entry, "set_host_tools", { tools: merged(entry.hostTools, toolName) });
      }
      if (entry.hostUriSchemes.size > 0) {
        await this.#send(entry, "set_host_uri_schemes", {
          schemes: merged(entry.hostUriSchemes, schemeName),
        });
      }
    });
    if (entry.askDialogOptedIn) await this.#send(entry, "set_ask_dialog", { enabled: true });
  }

  /** The entry a thread id names: its own, or the one it moved to by a session switch. */
  #entryOrUndefined(threadId: ThreadId): ChatEntry | undefined {
    const own = this.#entries.get(threadId);
    if (own !== undefined) return own;
    let current = threadId;
    const seen = new Set<ThreadId>();
    for (
      let next = this.#aliases.get(current);
      next !== undefined && !seen.has(current);
      next = this.#aliases.get(current)
    ) {
      seen.add(current);
      current = next;
    }
    return this.#entries.get(current);
  }

  /** The entry a thread id names; a chat whose process is stopping serves nothing. */
  #entry(threadId: ThreadId): ChatEntry {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined || this.#context.processRegistry.isStopping(entry.bootstrap.threadId)) {
      throw notFound(`No open thread ${threadId}`);
    }
    return entry;
  }

  /**
   * A request to a chat no host here serves. When another omp holds the chat, it is refused with the sentence that says
   * so: nothing is sent and no host starts on the file. Otherwise this returns, and `#entry` refuses as before.
   */
  async #refuseWhenHeldElsewhere(threadId: ThreadId, signal: AbortSignalLike): Promise<void> {
    const resolved = await this.#context.resolveThread(threadId, signal);
    if (resolved === undefined) return;
    const other = await this.#context.externalOmp(threadId, resolved.sessionFile, undefined);
    if (other !== "running") return;
    throw new AppFailure({
      code: "conflict",
      message:
        "Another omp has this chat open, so nothing was sent. Close that omp, then reload this page.",
      retryable: true,
    });
  }

  #preference(entry: ChatEntry, connectionId: string): Preference {
    return entry.preferences.get(connectionId) ?? { level: "off" };
  }

  /**
   * The viewers' preferences as one, told to the chat's host when they changed: the highest subagent level, and `full`
   * message updates when any viewer asks for them, else `delta`. With no viewer asking, the host's own default (`full`)
   * comes back.
   */
  #arbitrate(entry: ChatEntry): Promise<void> {
    const work = entry.arbitration.then(async () => {
      const preferences = [...entry.preferences.values()];
      const level = preferences.reduce<SubagentLevel>(
        (best, preference) =>
          LEVEL_RANK[preference.level] > LEVEL_RANK[best] ? preference.level : best,
        "off",
      );
      const messageUpdates: MessageUpdates | undefined = preferences.some(
        (preference) => preference.messageUpdates === "full",
      )
        ? "full"
        : preferences.some((preference) => preference.messageUpdates === "delta")
          ? "delta"
          : undefined;
      if (entry.appliedLevel !== level) {
        await this.#send(entry, "set_subagent_subscription", { level });
        entry.appliedLevel = level;
      }
      if (messageUpdates !== entry.appliedMessageUpdates) {
        await this.#send(entry, "set_event_options", { messageUpdates: messageUpdates ?? "full" });
        entry.appliedMessageUpdates = messageUpdates;
      }
    });
    entry.arbitration = work.catch(() => undefined);
    return work;
  }

  /** An arbitration a viewer leaving starts: its failure is logged, not the leaving connection's. */
  async #arbitrateQuietly(entry: ChatEntry): Promise<void> {
    await this.#arbitrate(entry).catch((error: unknown) =>
      this.#context.logger?.warn("chat_session.arbitration_failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * A `!` or `$` run, which omp reports only to its caller: every viewer hears it start and end, and the process is held
   * while it runs. A viewer giving up does not end the run.
   */
  async #shellRun(
    entry: ChatEntry,
    method: "bash" | "python",
    params: ChatHostMethodMap["bash" | "python"]["params"],
  ): Promise<ShellRunResult> {
    const release = this.#context.processRegistry.holdCommand(entry.bootstrap.threadId);
    const startedAt = Date.now();
    const input = "command" in params ? params.command : params.code;
    this.#receive(entry, { kind: "shell", method, input, status: "running", startedAt });
    let result: ShellRunResult | undefined;
    try {
      result = await this.#send(entry, method, params as never);
      return result;
    } finally {
      this.#receive(entry, {
        kind: "shell",
        method,
        input,
        status: "ended",
        startedAt,
        ...(result === undefined ? {} : { result }),
      });
      release();
    }
  }

  #watchPayloads(entry: ChatEntry, listener: (payload: ChatSessionEvent) => void): () => void {
    entry.payloadListeners.add(listener);
    return () => entry.payloadListeners.delete(listener);
  }

  /**
   * A prompt for the A1 gateway. The host's answer says whether a result follows; the result is the `prompt_result` that
   * carries this request's own id. A host that ends meanwhile fails the run, and an aborted signal gives up the wait
   * while omp's run goes on.
   */
  #commandPrompt(
    entry: ChatEntry,
    text: string,
    signal: AbortSignalLike | undefined,
  ): CommandPromptFuture {
    let requestId: string | undefined;
    const result = Promise.withResolvers<PromptResultEvent>();
    void result.promise.catch(() => undefined);
    const stop = this.#watchPayloads(entry, (payload) => {
      if (
        payload.kind === "process" &&
        (payload.status === "exited" || payload.status === "error")
      ) {
        result.reject(
          new AppFailure({
            code: "omp_exited",
            message: "omp stopped before the command finished. Try again.",
            retryable: true,
          }),
        );
      } else if (
        payload.kind === "event" &&
        payload.event.type === "prompt_result" &&
        payload.event.requestId === requestId
      ) {
        result.resolve(payload.event);
      }
    });
    const onAbort = (): void => result.reject(cancelled("The command was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    const answered = (async () => {
      if (signal?.aborted === true) throw cancelled("The command was cancelled.");
      await this.#ensureRunning(entry);
      const sent = entry.client.send("prompt", { text });
      requestId = sent.id;
      try {
        return await sent.answer;
      } catch (error) {
        throw requestFailure("prompt", error);
      }
    })();
    const admitted = answered.then((answer) => ({ agentInvoked: answer.resultFollows }));
    const outcome = answered
      .then(async (answer): Promise<CommandPromptOutcome> => {
        // A prompt omp handled where it stood (a built-in command, an extension's input hook) has no result to wait for.
        if (!answer.resultFollows) {
          return { agentInvoked: false, status: "completed", promptSettled: true };
        }
        const settled = await result.promise;
        return {
          agentInvoked: settled.agentInvoked,
          status: settled.status === "aborted" ? "aborted" : "completed",
          promptSettled: settled.agentInvoked ? settled.sessionSettled : true,
        };
      })
      .finally(() => {
        stop();
        signal?.removeEventListener("abort", onAbort);
      });
    return withAdmission(outcome, admitted);
  }

  /**
   * After a session switch, the chat moves to omp's new id for it: the registry is rekeyed, viewers on the old id hear
   * the move, the stream carries on under the new id with its history, and the old id stays an alias.
   */
  async #refreshIdentity(entry: ChatEntry): Promise<void> {
    const identity = await this.#identity(entry);
    const current = entry.bootstrap.threadId;
    if (identity.threadId === current && identity.sessionFile === entry.bootstrap.sessionFile)
      return;
    const existing = this.#entries.get(identity.threadId);
    if (existing !== undefined && existing !== entry) {
      throw new AppFailure({
        code: "conflict",
        message: "omp switched to a session already open in another chat.",
        retryable: false,
      });
    }
    // The registry's rekey can refuse; it runs first, so a refusal leaves the stream and the process as they were.
    this.#moveProcess(current, identity.threadId);
    this.#publish(entry, {
      kind: "moved",
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    });
    const stream = chatSessionEventStream(identity.threadId);
    this.#context.replay.moveStream(entry.stream, stream);
    this.#aliases.set(current, identity.threadId);
    this.#entries.delete(current);
    entry.bootstrap = {
      ...entry.bootstrap,
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    };
    entry.stream = stream;
    this.#entries.set(identity.threadId, entry);
  }

  /** Moves a process to the chat's own id; the registry refuses an id another process holds (a chat open elsewhere). */
  #moveProcess(from: ThreadId, to: ThreadId): void {
    try {
      this.#context.processRegistry.rekey(from, to);
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict")
        throw chatOpenElsewhere(error);
      throw error;
    }
  }

  #openResult(entry: ChatEntry): ChatOpenResult {
    return {
      threadId: entry.bootstrap.threadId,
      sessionFile: entry.bootstrap.sessionFile,
      methods: [...entry.methods],
    };
  }

  #processOptions(bootstrap: ThreadBootstrap): OmpProcessOptions {
    return { threadId: bootstrap.threadId, folder: bootstrap.folderPath, args: bootstrap.args };
  }

  #hasSessionFile(sessionFile: SessionFilePath): Promise<boolean> {
    return this.#context.sessionFileExists
      ? this.#context.sessionFileExists(sessionFile)
      : Bun.file(sessionFile).exists();
  }
}

export interface ChatSessionPortRegistration {
  readonly port: typeof ChatSessionPort;
  readonly runtime: ChatSessionPortRuntime;
}

export function createChatSessionPortRuntime(context: A0PortContext): ChatSessionPortRegistration {
  return { port: ChatSessionPort, runtime: new ChatSessionPortRuntime(context) };
}
