/**
 * A0's runtime for chats on the chat host (SDK plan H5.3, `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.3 design"): one chat
 * host process per chat, the protocol's requests and events, and the duties of A0's RPC runtime (`./rpc-session.ts`)
 * carried over. H5.3a has the core:
 * - opening a chat: new, resumed from its file, the folder's newest (`--continue`), with a picked model;
 * - requests;
 * - the chat's stream;
 * - viewers per connection;
 * - the registry's busy and settled marks;
 * - restart, and the repair before a request.
 * H5.3b adds the host's requests (dialogs, approvals, tools, URIs) and the host registrations; H5.3c the arbitration,
 * `!` events, rename, session switches and the reopen after a refused delete.
 */
import { join } from "node:path";
import {
  type AbortSignalLike,
  AppFailure,
  type ChatOpenResult,
  type ChatRequestArgs,
  type ChatSessionEvent,
  ChatSessionPort,
  chatSessionEventStream,
  type FolderPath,
  type ModelChoice,
  type OpenThreadArgs,
  SessionFilePath,
  type StreamKey,
  type SubscribeArgs,
  ThreadId,
} from "@omp-app/contracts";
import {
  type ChatEvent,
  type ChatHostMethod,
  type ChatHostMethodMap,
  parseChatHostParams,
} from "@omp-app/contracts/chat-host";
import { modelUnavailableFailure, savedModelFromOmpText } from "@omp-app/omp-rpc";
import { ChatHostClient, ChatHostRequestError } from "../../chat-host/client";
import type { OmpProcess, OmpProcessOptions } from "../../process";
import type { PortHandler, PortHandlerContext } from "../../registry/ports";
import type { A0PortContext, ThreadBootstrap } from "./rpc-session";
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

  constructor(context: A0PortContext) {
    this.#context = context;
    context.processRegistry.setIdleHooks({
      isSettled: (threadId) => this.#isSettled(threadId),
      stopped: (threadId, process) => this.#forgetStopped(threadId, process),
    });
  }

  readonly handlers: Readonly<Record<string, PortHandler>> = {
    // The dispatcher parses each method's zod args before invoking this boundary.
    open: (args, call) => this.open(args as OpenThreadArgs, call),
    request: (args) => this.request(args as ChatRequestArgs),
    subscribe: (args) => this.subscribe(args as SubscribeArgs),
    restart: (args) => this.restart(args as { threadId: ThreadId }),
    close: (args, call) => this.close(args as { threadId: ThreadId }, call),
  };

  /** The session file an open chat runs, known before omp writes it (a new chat writes its file after its first reply). */
  sessionFileOf(threadId: ThreadId): SessionFilePath | undefined {
    return this.#entries.get(threadId)?.bootstrap.sessionFile;
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

  /** A request by a method's name: its params are checked against the method before the host sees them. */
  async request(args: ChatRequestArgs): Promise<unknown> {
    const entry = this.#entry(args.threadId);
    await this.#ensureRunning(entry);
    const method = args.method as ChatHostMethod;
    const params = parseChatHostParams(method, args.params);
    if (!params.ok) {
      throw new AppFailure({
        code: "invalid_args",
        message: params.error.message,
        retryable: false,
      });
    }
    try {
      return await entry.client.request(
        method,
        params.value as ChatHostMethodMap[typeof method]["params"],
      );
    } catch (error) {
      throw requestFailure(method, error);
    }
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
    const entry = this.#entries.get(args.threadId);
    if (entry !== undefined) this.#releaseView(entry, call.connectionId);
    return null;
  }

  /**
   * A browser connection closed (a tab closed or reloaded, the network lost): every view it held is released, as if it
   * had closed each one. A process nobody watches is stopped by the registry after its idle time, unless it is working.
   */
  async releaseConnection(connectionId: string): Promise<void> {
    for (const entry of this.#entries.values()) {
      const count = entry.viewers.get(connectionId) ?? 0;
      entry.viewers.delete(connectionId);
      for (let view = 0; view < count; view += 1) {
        this.#context.processRegistry.release(entry.bootstrap.threadId);
      }
    }
  }

  /** How many views one connection holds on a chat. */
  viewsOf(threadId: ThreadId, connectionId: string): number {
    return this.#entries.get(threadId)?.viewers.get(connectionId) ?? 0;
  }

  /** How many views every connection holds on a chat together: the count the chat's process is watched by. */
  watcherCount(threadId: ThreadId): number {
    let total = 0;
    for (const count of this.#entries.get(threadId)?.viewers.values() ?? []) total += count;
    return total;
  }

  /** Lets go of every view one connection holds on a chat, as deleting the chat does; other connections keep theirs. */
  async releaseViews(threadId: ThreadId, connectionId: string): Promise<void> {
    const entry = this.#entries.get(threadId);
    const count = entry?.viewers.get(connectionId) ?? 0;
    if (entry === undefined || count === 0) return;
    entry.viewers.delete(connectionId);
    for (let view = 0; view < count; view += 1) {
      this.#context.processRegistry.release(entry.bootstrap.threadId);
    }
  }

  /**
   * Gives a connection back the views a delete's stop took from it, joined to the chat's running process. A chat no
   * running process serves gets nothing: no process starts for it.
   */
  restoreViews(threadId: ThreadId, connectionId: string, count: number): void {
    const entry = this.#entries.get(threadId);
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
    for (const entry of this.#entries.values()) {
      entry.unsubscribe();
      entry.client.dispose();
    }
    this.#entries.clear();
    await this.#context.processRegistry.closeAll();
  }

  /** Starts the chat's process and waits for its host's hello. */
  async #start(entry: ChatEntry): Promise<void> {
    await entry.process.start();
    let hello: Awaited<ChatHostClient["hello"]>;
    try {
      hello = await entry.client.hello;
    } catch {
      throw new AppFailure({
        code: "omp_exited",
        message: "omp stopped while it was starting. Try again.",
        retryable: true,
      });
    }
    entry.methods = hello.methods;
    this.#receive(entry, { kind: "process", status: "ready", startedAt: entry.startedAt });
  }

  /** The host's events and the process's life, into the chat's stream. */
  #listen(entry: ChatEntry): () => void {
    const fromHost = entry.client.onEvent((event) =>
      this.#receive(entry, { kind: "event", event }),
    );
    const fromProcess = entry.process.onEvent((event) =>
      this.#receive(entry, {
        kind: "process",
        status: event.status,
        startedAt: entry.startedAt,
        ...(event.error === undefined ? {} : { error: event.error }),
      }),
    );
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
    this.#context.replay.publish(entry.stream, payload);
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
    const provisional = entry.bootstrap.threadId;
    // The registry refuses an id another process holds: the chat is open in another tab or window.
    try {
      this.#context.processRegistry.rekey(provisional, identity.threadId);
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "conflict")
        throw chatOpenElsewhere(error);
      throw error;
    }
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
      this.#context.replay.publish(entry.stream, payload);
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
    entry.bootstrap = { ...entry.bootstrap, args };
    entry.process = process;
    entry.client = new ChatHostClient(process);
    entry.startedAt = Date.now();
    entry.unsubscribe = this.#listen(entry);
    await this.#start(entry);
  }

  /** Whether the chat's host says it has settled; a chat nothing holds counts as settled. */
  async #isSettled(threadId: ThreadId): Promise<boolean> {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return true;
    return (await entry.client.request("get_state", {})).isSettled;
  }

  /** The registry stopped a chat's process on purpose: its entry can't serve again, so the next open starts fresh. */
  #forgetStopped(threadId: ThreadId, process: OmpProcess): void {
    const entry = this.#entries.get(threadId);
    if (entry === undefined || entry.process !== process) return;
    this.#forget(entry);
  }

  #forget(entry: ChatEntry): void {
    entry.unsubscribe();
    entry.client.dispose();
    this.#entries.delete(entry.bootstrap.threadId);
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

  /** The entry a thread id names; a chat whose process is stopping serves nothing. */
  #entry(threadId: ThreadId): ChatEntry {
    const entry = this.#entries.get(threadId);
    if (entry === undefined || this.#context.processRegistry.isStopping(threadId)) {
      throw notFound(`No open thread ${threadId}`);
    }
    return entry;
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
