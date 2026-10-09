import { join } from "node:path";
import {
  type AbortSignalLike,
  type AnswerExtensionUiArgs,
  type AnswerHostToolArgs,
  type AnswerHostUriArgs,
  AppFailure,
  type CapabilityMap,
  type FolderPath,
  type OmpWire,
  type OpenThreadArgs,
  type RpcSessionEvent,
  RpcSessionPort,
  type RpcSessionPort as RpcSessionPortContract,
  rpcSessionEventStream,
  type SendCommandArgs,
  SessionFilePath,
  type SessionRenameArgs,
  type SetEventFilterArgs,
  type SetSubagentSubscriptionArgs,
  type StreamKey,
  type SubscribeArgs,
  ThreadId,
} from "@omp-app/contracts";
import { type CommandFuture, RpcSession } from "@omp-app/omp-rpc";
import { z } from "zod";
import { capabilitiesForProtocol } from "../../capabilities";
import type { Logger } from "../../logging";
import type {
  ExternalOmpState,
  OmpProcess,
  OmpProcessOptions,
  OmpProcessRegistry,
} from "../../process";
import type { PortHandler, PortHandlerContext } from "../../registry/ports";
import type { EventReplayHub } from "../../replay";

export interface ThreadBootstrap {
  readonly threadId: ThreadId;
  readonly folderPath: FolderPath;
  readonly sessionFile: SessionFilePath;
  readonly args?: readonly string[];
}

export interface A0PortContext {
  readonly processRegistry: OmpProcessRegistry;
  readonly replay: EventReplayHub;
  readonly capabilities: CapabilityMap;
  readonly serverInfo: {
    readonly instanceId: string;
    readonly serverVersion: string;
    readonly launchFolder: FolderPath;
    readonly omp: { readonly version: string; readonly protocolVersion: 1 | 2 } | null;
    /** Where the debug log is written; absent without one. */
    readonly logFile?: string;
  };
  readonly health: { readonly status: "ok" | "degraded" | "unhealthy"; readonly detail?: string };
  /** Required catalog seam: A1 resolves the omp-authoritative session file and cwd for a ThreadId. */
  readonly resolveThread: (
    threadId: ThreadId,
    signal: AbortSignalLike,
  ) => Promise<ThreadBootstrap | undefined>;
  /**
   * Whether another omp is writing a chat (omp's lease on the chat's file). A rename of a chat nobody
   * has open goes ahead only on "none": omp writes a chat to a copy when another process holds its file.
   */
  readonly externalOmp: (
    threadId: ThreadId,
    sessionFile: SessionFilePath,
    /** The rename host this runtime started for the chat: it is not another omp. */
    hostPid: number | undefined,
  ) => Promise<ExternalOmpState>;
  /** Test seam and process adapter seam; defaults to the merged A0.3 RpcSession. */
  readonly createSession?: (process: OmpProcess) => RpcSession;
  /** The debug log; browser-reported errors are written to it. */
  readonly logger?: Logger;
  /** Builds the debug report the browser can save; absent when the app runs without a debug log. */
  readonly debugReport?: () => Promise<{ readonly fileName: string; readonly text: string }>;
}

interface ViewerPreference {
  readonly level: "off" | "progress" | "events";
  readonly events: string[] | null;
  readonly messageUpdates?: "full" | "delta";
}

interface ThreadEntry {
  bootstrap: ThreadBootstrap;
  process: OmpProcess;
  session: RpcSession;
  stream: StreamKey;
  unsubscribeEvents: () => void;
  readonly viewers: Map<string, number>;
  readonly preferences: Map<string, ViewerPreference>;
  readonly startupEvents: RpcSessionEvent[];
  hostToolRegistrations: Map<string, Map<string, readonly OmpWire.HostToolDefinition[]>>;
  hostUriRegistrations: Map<string, Map<string, readonly OmpWire.HostUriSchemeDefinition[]>>;
  hostRegistrationQueue: Promise<void>;
  rekeyed: boolean;
  appliedLevel?: ViewerPreference["level"];
  appliedEvents?: string[] | null;
  appliedMessageUpdates?: ViewerPreference["messageUpdates"];
  arbitration: Promise<void>;
}

const LEVEL_RANK: Record<ViewerPreference["level"], number> = {
  off: 0,
  progress: 1,
  events: 2,
};
const SESSION_SWITCH_COMMANDS: Record<string, true> = {
  branch: true,
  new_session: true,
  switch_session: true,
  open_session: true,
  fork: true,
};
const HostToolNamesResult = z.strictObject({ toolNames: z.array(z.string()) });
const HostUriSchemesResult = z.strictObject({ schemes: z.array(z.string()) });
function mergeHostTools(
  registrations: Map<string, Map<string, readonly OmpWire.HostToolDefinition[]>>,
): OmpWire.HostToolDefinition[] {
  const merged = new Map<string, OmpWire.HostToolDefinition>();
  for (const owners of registrations.values()) {
    for (const tools of owners.values()) {
      for (const tool of tools) merged.set(tool.name, tool);
    }
  }
  return [...merged.values()];
}

function mergeHostUriSchemes(
  registrations: Map<string, Map<string, readonly OmpWire.HostUriSchemeDefinition[]>>,
): OmpWire.HostUriSchemeDefinition[] {
  const merged = new Map<string, OmpWire.HostUriSchemeDefinition>();
  for (const owners of registrations.values()) {
    for (const schemes of owners.values()) {
      for (const scheme of schemes) merged.set(scheme.scheme, scheme);
    }
  }
  return [...merged.values()];
}

function notFound(message: string): AppFailure {
  return new AppFailure({ code: "not_found", message, retryable: false });
}
function unavailable(message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: true });
}
function provisionalBootstrap(folderPath: FolderPath, args: readonly string[]): ThreadBootstrap {
  const threadId = ThreadId.parse(`provisional-${crypto.randomUUID()}`);
  const sessionFile = SessionFilePath.parse(join(folderPath, ".omp", `${threadId}.jsonl`));
  return { threadId, folderPath, sessionFile, args };
}
function readSessionState(value: unknown): {
  readonly threadId: ThreadId;
  readonly sessionFile: SessionFilePath;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppFailure({
      code: "invalid_args",
      message: "omp returned an invalid session state",
      retryable: false,
    });
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || typeof record.sessionFile !== "string") {
    throw new AppFailure({
      code: "invalid_args",
      message: "omp returned an incomplete session state",
      retryable: false,
    });
  }
  try {
    return {
      threadId: ThreadId.parse(record.sessionId),
      sessionFile: SessionFilePath.parse(record.sessionFile),
    };
  } catch {
    throw new AppFailure({
      code: "invalid_args",
      message: "omp returned invalid session identity",
      retryable: false,
    });
  }
}

/**
 * Whether omp says it is idle: no turn running, nothing queued, no background work that could wake
 * it. omp 18.6.1 (the supported floor) may not report `isSettled`, so the parts it does report are
 * combined; a state that can't be read counts as not settled, so the process is kept.
 */
function readSettled(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("isSettled" in value && typeof value.isSettled === "boolean") return value.isSettled;
  const streaming = "isStreaming" in value && value.isStreaming === true;
  const compacting = "isCompacting" in value && value.isCompacting === true;
  const asyncWork = "hasPendingAsyncWork" in value && value.hasPendingAsyncWork === true;
  const queued =
    "queuedMessageCount" in value &&
    typeof value.queuedMessageCount === "number" &&
    value.queuedMessageCount > 0;
  return !streaming && !compacting && !asyncWork && !queued;
}

/** A0's stateful bridge between the typed ports and one process/session per thread. */
export class RpcSessionPortRuntime {
  readonly #context: A0PortContext;
  readonly #entries = new Map<ThreadId, ThreadEntry>();
  readonly #aliases = new Map<ThreadId, ThreadId>();
  /** The renames of each chat, one after another: a second rename waits for the first to finish. */
  readonly #renames = new Map<ThreadId, Promise<void>>();

  constructor(context: A0PortContext) {
    this.#context = context;
    context.processRegistry.setIdleHooks({
      isSettled: (threadId) => this.#isSettled(threadId),
      stopping: (threadId, process) => this.#forgetStopped(threadId, process),
    });
  }

  readonly handlers: Readonly<Record<string, PortHandler>> = {
    // DispatcherSession parses each method's zod args before invoking this boundary.
    open: (args, call) => this.open(args as OpenThreadArgs, call),
    rename: (args, call) => this.rename(args as SessionRenameArgs, call),
    send: (args, call) => this.send(args as SendCommandArgs, call),
    subscribe: (args, call) => this.subscribe(args as SubscribeArgs, call),
    answerExtensionUi: (args, call) => this.answerExtensionUi(args as AnswerExtensionUiArgs, call),
    answerHostTool: (args, call) => this.answerHostTool(args as AnswerHostToolArgs, call),
    answerHostUri: (args, call) => this.answerHostUri(args as AnswerHostUriArgs, call),
    setSubagentSubscription: (args, call) =>
      this.setSubagentSubscription(args as SetSubagentSubscriptionArgs, call),
    setEventFilter: (args, call) => this.setEventFilter(args as SetEventFilterArgs, call),
    restart: (args, call) => this.restart(args as { threadId: ThreadId }, call),
    close: (args, call) => this.close(args as { threadId: ThreadId }, call),
  };

  get entries(): ReadonlyMap<ThreadId, ThreadEntry> {
    return this.#entries;
  }
  sessionFor(threadId: ThreadId): RpcSession | undefined {
    return this.#entryOrUndefined(threadId)?.session;
  }

  async open(args: OpenThreadArgs, call: PortHandlerContext) {
    if (this.#context.health.status !== "ok") {
      throw unavailable(this.#context.health.detail ?? "omp is unavailable");
    }
    const bootstrap = await this.#resolveBootstrap(args, call);
    // A process the registry is stopping for this thread holds the session's lease until it exits.
    await this.#context.processRegistry.whenStopped(bootstrap.threadId);
    const existing = this.#entries.get(bootstrap.threadId);
    if (existing !== undefined) {
      if (existing.bootstrap.folderPath !== bootstrap.folderPath) {
        throw new AppFailure({
          code: "conflict",
          message: "The thread is already open in a different folder",
          retryable: false,
        });
      }
      this.#context.processRegistry.acquire(this.#processOptions(bootstrap));
      this.#addViewer(existing, call.connectionId);
      return this.#openResult(existing);
    }

    const process = this.#context.processRegistry.acquire(this.#processOptions(bootstrap));
    const session = this.#context.createSession?.(process) ?? new RpcSession(process);
    const entry: ThreadEntry = {
      bootstrap,
      process,
      session,
      stream: rpcSessionEventStream(bootstrap.threadId),
      unsubscribeEvents: () => undefined,
      viewers: new Map(),
      preferences: new Map(),
      startupEvents: [],
      hostToolRegistrations: new Map(),
      hostUriRegistrations: new Map(),
      hostRegistrationQueue: Promise.resolve(),
      rekeyed: false,
      arbitration: Promise.resolve(),
    };
    entry.unsubscribeEvents = session.onEvent((event) => {
      if (!entry.rekeyed) {
        entry.startupEvents.push(event);
        return;
      }
      this.#context.replay.publish(entry.stream, event satisfies RpcSessionEvent);
    });
    this.#aliases.delete(bootstrap.threadId);
    this.#entries.set(bootstrap.threadId, entry);
    this.#addViewer(entry, call.connectionId);
    try {
      await process.start();
      await session.start();
      const state = await session.send({ type: "get_state" });
      await this.#rekeyEntry(entry, "threadId" in args ? args.threadId : undefined, state);
    } catch (error) {
      await session.close();
      this.#dropEntry(entry);
      if (
        "threadId" in args &&
        error instanceof AppFailure &&
        error.appError.code === "omp_exited"
      ) {
        throw notFound(error.appError.message);
      }
      throw error;
    }
    return this.#openResult(entry);
  }

  async send<K extends SendCommandArgs["command"]["type"]>(
    args: SendCommandArgs<K>,
    call: PortHandlerContext,
  ): Promise<unknown> {
    const entry = this.#entry(args.threadId);
    if (args.command.type === "set_host_tools") {
      const owner = args.registrationOwner;
      if (owner === undefined) {
        throw new AppFailure({
          code: "invalid_args",
          message: "A host registration owner is required.",
          retryable: false,
        });
      }
      this.#requireViewer(entry, call.connectionId);
      return this.#setHostTools(entry, call.connectionId, owner, args.command.tools, call.signal);
    }
    if (args.command.type === "set_host_uri_schemes") {
      const owner = args.registrationOwner;
      if (owner === undefined) {
        throw new AppFailure({
          code: "invalid_args",
          message: "A host registration owner is required.",
          retryable: false,
        });
      }
      this.#requireViewer(entry, call.connectionId);
      return this.#setHostUriSchemes(
        entry,
        call.connectionId,
        owner,
        args.command.schemes,
        call.signal,
      );
    }
    const future = entry.session.send(args.command, { signal: call.signal }) as CommandFuture<
      unknown,
      unknown
    >;
    void future.catch(() => undefined);
    const admitted = await future.admitted;
    if (SESSION_SWITCH_COMMANDS[args.command.type] === true) {
      await this.#refreshIdentity(entry, call.signal);
    }
    return admitted;
  }

  /**
   * Renames a chat. A chat that is open is renamed by its own omp. A chat nobody has open is renamed
   * by a short-lived omp for it: opened, checked for another omp's lease, asked to set the name, and
   * stopped again at once, whatever the outcome.
   */
  async rename(args: SessionRenameArgs, call: PortHandlerContext): Promise<null> {
    await this.#serializeRename(args.threadId, async () => {
      const entry = this.#entryOrUndefined(args.threadId);
      if (entry === undefined) {
        await this.#renameClosed(args, call);
        return;
      }
      await entry.session.send(
        { type: "set_session_name", name: args.name },
        { signal: call.signal },
      );
    });
    return null;
  }

  async #renameClosed(args: SessionRenameArgs, call: PortHandlerContext): Promise<void> {
    const resolved = await this.#context.resolveThread(args.threadId, call.signal);
    if (resolved === undefined) throw notFound(`Thread ${args.threadId} was not found`);
    // A process this server is still stopping holds the chat's file until it exits.
    await this.#context.processRegistry.whenStopped(args.threadId);
    const opened = await this.open({ threadId: args.threadId }, call);
    try {
      // Checked after this host is up and before it writes. omp takes a chat's lease only when it
      // writes, so this is the point where another omp that has written the chat shows up, and a
      // refusal here leaves the chat exactly as it was.
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
      await entry.session.send(
        { type: "set_session_name", name: args.name },
        { signal: call.signal },
      );
      // Another omp can start writing between the check and this write; omp then moves the chat to a copy.
      const identity = readSessionState(
        await entry.session.send({ type: "get_state" }, { signal: call.signal }),
      );
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
      await this.#context.processRegistry.stopIfUnwatched(args.threadId);
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
  #setHostTools(
    entry: ThreadEntry,
    connectionId: string,
    owner: string,
    tools: readonly OmpWire.HostToolDefinition[],
    signal: AbortSignalLike,
  ): Promise<{ readonly toolNames: string[] }> {
    return this.#serializeHostRegistrations(entry, async () => {
      const next = new Map(entry.hostToolRegistrations);
      const owners = new Map(next.get(connectionId) ?? []);
      owners.set(owner, tools);
      next.set(connectionId, owners);
      const registeredNames = await this.#writeHostTools(entry, next, signal);
      entry.hostToolRegistrations = next;
      const ownerNames = new Set(tools.map((tool) => tool.name));
      return { toolNames: registeredNames.filter((name) => ownerNames.has(name)) };
    });
  }

  #setHostUriSchemes(
    entry: ThreadEntry,
    connectionId: string,
    owner: string,
    schemes: readonly OmpWire.HostUriSchemeDefinition[],
    signal: AbortSignalLike,
  ): Promise<{ readonly schemes: string[] }> {
    return this.#serializeHostRegistrations(entry, async () => {
      const next = new Map(entry.hostUriRegistrations);
      const owners = new Map(next.get(connectionId) ?? []);
      owners.set(owner, schemes);
      next.set(connectionId, owners);
      const registeredSchemes = await this.#writeHostUriSchemes(entry, next, signal);
      entry.hostUriRegistrations = next;
      const ownerSchemes = new Set(schemes.map((scheme) => scheme.scheme));
      return { schemes: registeredSchemes.filter((scheme) => ownerSchemes.has(scheme)) };
    });
  }

  async #writeHostTools(
    entry: ThreadEntry,
    registrations: Map<string, Map<string, readonly OmpWire.HostToolDefinition[]>>,
    signal: AbortSignalLike,
  ): Promise<string[]> {
    const future = entry.session.send(
      { type: "set_host_tools", tools: mergeHostTools(registrations) },
      { signal },
    ) as CommandFuture<unknown, unknown>;
    void future.catch(() => undefined);
    const result = HostToolNamesResult.safeParse(await future.admitted);
    if (!result.success) {
      throw new AppFailure({
        code: "internal",
        message: "omp returned an invalid host tool registration result.",
        retryable: false,
      });
    }
    return result.data.toolNames;
  }

  async #writeHostUriSchemes(
    entry: ThreadEntry,
    registrations: Map<string, Map<string, readonly OmpWire.HostUriSchemeDefinition[]>>,
    signal: AbortSignalLike,
  ): Promise<string[]> {
    const future = entry.session.send(
      { type: "set_host_uri_schemes", schemes: mergeHostUriSchemes(registrations) },
      { signal },
    ) as CommandFuture<unknown, unknown>;
    void future.catch(() => undefined);
    const result = HostUriSchemesResult.safeParse(await future.admitted);
    if (!result.success) {
      throw new AppFailure({
        code: "internal",
        message: "omp returned an invalid host URI registration result.",
        retryable: false,
      });
    }
    return result.data.schemes;
  }

  #serializeHostRegistrations<T>(entry: ThreadEntry, operation: () => Promise<T>): Promise<T> {
    const current = entry.hostRegistrationQueue.then(operation, operation);
    entry.hostRegistrationQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
  #releaseHostRegistrations(
    entry: ThreadEntry,
    connectionId: string,
    signal: AbortSignalLike,
  ): Promise<void> {
    return this.#serializeHostRegistrations(entry, async () => {
      const hasTools = entry.hostToolRegistrations.has(connectionId);
      const hasSchemes = entry.hostUriRegistrations.has(connectionId);
      if (!hasTools && !hasSchemes) return;

      const tools = new Map(entry.hostToolRegistrations);
      const schemes = new Map(entry.hostUriRegistrations);
      tools.delete(connectionId);
      schemes.delete(connectionId);
      entry.hostToolRegistrations = tools;
      entry.hostUriRegistrations = schemes;

      const updates: Promise<unknown>[] = [];
      if (hasTools) updates.push(this.#writeHostTools(entry, tools, signal));
      if (hasSchemes) updates.push(this.#writeHostUriSchemes(entry, schemes, signal));
      const results = await Promise.allSettled(updates);
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            "[omp-app] could not remove a closed connection's host registrations",
            result.reason,
          );
        }
      }
    });
  }

  #reapplyHostRegistrations(entry: ThreadEntry, signal: AbortSignalLike): Promise<void> {
    return this.#serializeHostRegistrations(entry, async () => {
      const updates: Promise<unknown>[] = [];
      if (entry.hostToolRegistrations.size > 0) {
        updates.push(this.#writeHostTools(entry, entry.hostToolRegistrations, signal));
      }
      if (entry.hostUriRegistrations.size > 0) {
        updates.push(this.#writeHostUriSchemes(entry, entry.hostUriRegistrations, signal));
      }
      await Promise.all(updates);
    });
  }

  subscribe(args: SubscribeArgs, _call: PortHandlerContext) {
    return { stream: this.#entry(args.threadId).stream };
  }

  async answerExtensionUi(args: AnswerExtensionUiArgs, _call: PortHandlerContext): Promise<null> {
    await this.#entry(args.threadId).session.answerExtensionUi(args.response);
    return null;
  }

  async answerHostTool(args: AnswerHostToolArgs, _call: PortHandlerContext): Promise<null> {
    await this.#entry(args.threadId).session.answerHostTool(args.response);
    return null;
  }

  async answerHostUri(args: AnswerHostUriArgs, _call: PortHandlerContext): Promise<null> {
    await this.#entry(args.threadId).session.answerHostUri(args.response);
    return null;
  }

  async setSubagentSubscription(args: SetSubagentSubscriptionArgs, call: PortHandlerContext) {
    const entry = this.#entry(args.threadId);
    const preference = this.#preference(entry, call.connectionId);
    entry.preferences.set(call.connectionId, { ...preference, level: args.level });
    await this.#arbitrate(entry, call.signal);
    return { level: this.#appliedLevel(entry) };
  }

  async setEventFilter(args: SetEventFilterArgs, call: PortHandlerContext) {
    const entry = this.#entry(args.threadId);
    const preference = this.#preference(entry, call.connectionId);
    entry.preferences.set(call.connectionId, {
      ...preference,
      events: args.events,
      messageUpdates: args.messageUpdates,
    });
    await this.#arbitrate(entry, call.signal);
    return {
      events: entry.appliedEvents ?? null,
      ...(entry.appliedMessageUpdates === undefined
        ? {}
        : { messageUpdates: entry.appliedMessageUpdates }),
    };
  }

  async restart(args: { threadId: ThreadId }, call: PortHandlerContext): Promise<null> {
    const entry = this.#entry(args.threadId);
    const viewerCount = [...entry.viewers.values()].reduce((total, count) => total + count, 0);
    entry.unsubscribeEvents();
    await entry.session.close();
    const process = this.#context.processRegistry.acquire(this.#processOptions(entry.bootstrap));
    for (let index = 1; index < viewerCount; index++) {
      this.#context.processRegistry.acquire(this.#processOptions(entry.bootstrap));
    }
    const replacement = this.#context.createSession?.(process) ?? new RpcSession(process);
    entry.process = process;
    entry.session = replacement;
    entry.unsubscribeEvents = replacement.onEvent((event) => {
      this.#context.replay.publish(entry.stream, event satisfies RpcSessionEvent);
    });
    await process.start();
    await replacement.start();
    await this.#reapplyHostRegistrations(entry, call.signal);
    return null;
  }

  async close(args: { threadId: ThreadId }, call: PortHandlerContext): Promise<null> {
    const entry = this.#entry(args.threadId);
    const count = entry.viewers.get(call.connectionId) ?? 0;
    if (count > 0) {
      if (count === 1) {
        await this.#releaseHostRegistrations(entry, call.connectionId, call.signal);
        entry.viewers.delete(call.connectionId);
      } else entry.viewers.set(call.connectionId, count - 1);
      entry.preferences.delete(call.connectionId);
      this.#context.processRegistry.release(entry.bootstrap.threadId);
      await this.#arbitrate(entry, call.signal);
    }
    return null;
  }

  /**
   * A browser connection closed (tab closed or reloaded, network lost): everything it was viewing
   * is released, as if it had called `close` for each open it made. The browser used to call
   * `close` for nothing, so every chat a tab ever opened kept its omp process (about 380 MB while
   * idle) running until the server stopped. A process nobody watches any more is stopped by the
   * process registry after its idle time, unless it is still running a turn.
   */
  async releaseConnection(connectionId: string): Promise<void> {
    const stillWatched: ThreadEntry[] = [];
    for (const entry of new Set(this.#entries.values())) {
      const count = entry.viewers.get(connectionId) ?? 0;
      if (count === 0) continue;
      await this.#releaseHostRegistrations(entry, connectionId, new AbortController().signal);
      entry.viewers.delete(connectionId);
      entry.preferences.delete(connectionId);
      for (let opened = 0; opened < count; opened += 1) {
        this.#context.processRegistry.release(entry.bootstrap.threadId);
      }
      if (entry.viewers.size > 0) stillWatched.push(entry);
    }
    // Another tab still watching a chat: its subscription level is recomputed without this one.
    const results = await Promise.allSettled(
      stillWatched.map((entry) => this.#arbitrate(entry, new AbortController().signal)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(
          "[omp-app] could not update a chat's subscription after a tab closed",
          result.reason,
        );
      }
    }
  }

  async dispose(): Promise<void> {
    for (const entry of this.#entries.values()) entry.unsubscribeEvents();
    this.#entries.clear();
    this.#aliases.clear();
    await this.#context.processRegistry.closeAll();
  }

  /** The entry a thread id names: its own, or the one it moved to by a session switch. */
  #entryOrUndefined(threadId: ThreadId): ThreadEntry | undefined {
    const own = this.#entries.get(threadId);
    if (own !== undefined) return own;
    let current = threadId;
    const seen = new Set<ThreadId>();
    while (this.#aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      const next = this.#aliases.get(current);
      if (next === undefined) break;
      current = next;
    }
    return this.#entries.get(current);
  }

  #entry(threadId: ThreadId): ThreadEntry {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined) throw notFound(`No open thread ${threadId}`);
    return entry;
  }

  /** Host registrations are released through a connection's viewer count, so only a viewer may make one. */
  #requireViewer(entry: ThreadEntry, connectionId: string): void {
    if ((entry.viewers.get(connectionId) ?? 0) > 0) return;
    throw notFound(
      "Open this chat on this connection before registering host tools or URI schemes.",
    );
  }

  async #resolveBootstrap(
    args: OpenThreadArgs,
    call: PortHandlerContext,
  ): Promise<ThreadBootstrap> {
    if ("threadId" in args) {
      const existing = this.#entries.get(args.threadId);
      if (existing !== undefined) return existing.bootstrap;
      const resolved = await this.#context.resolveThread(args.threadId, call.signal);
      if (resolved === undefined) throw notFound(`Thread ${args.threadId} was not found`);
      return { ...resolved, args: ["--resume", resolved.sessionFile] };
    }
    if (args.start === "new") return provisionalBootstrap(args.folderPath, []);
    return provisionalBootstrap(args.folderPath, ["--continue"]);
  }

  async #rekeyEntry(
    entry: ThreadEntry,
    requestedThreadId: ThreadId | undefined,
    state: unknown,
  ): Promise<void> {
    const identity = readSessionState(state);
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
    this.#context.processRegistry.rekey(provisional, identity.threadId);
    this.#entries.delete(provisional);
    entry.bootstrap = {
      ...entry.bootstrap,
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    };
    entry.stream = rpcSessionEventStream(identity.threadId);
    this.#entries.set(identity.threadId, entry);
    entry.rekeyed = true;
    const startupEvents = entry.startupEvents.splice(0);
    for (const event of startupEvents) {
      this.#context.replay.publish(entry.stream, event satisfies RpcSessionEvent);
    }
  }

  async #refreshIdentity(entry: ThreadEntry, signal: AbortSignalLike): Promise<void> {
    const identity = readSessionState(await entry.session.send({ type: "get_state" }, { signal }));
    const current = entry.bootstrap.threadId;
    if (identity.threadId === current && identity.sessionFile === entry.bootstrap.sessionFile)
      return;
    const existing = this.#entries.get(identity.threadId);
    if (existing !== undefined && existing !== entry) {
      throw new AppFailure({
        code: "conflict",
        message: "omp switched to a session id already open in another thread",
        retryable: false,
      });
    }
    // The registry's re-key can refuse (the new id is already registered); it runs first, so a refusal
    // leaves the stream and the process exactly as they were.
    this.#context.processRegistry.rekey(current, identity.threadId);
    // Browsers still attached to the old id hear that the chat moved, with the new id. The stream
    // carries on under the new id so their sequence numbers stay contiguous; the process is untouched.
    this.#context.replay.publish(entry.stream, {
      kind: "notification",
      frame: { type: "session_info_update", sessionId: identity.threadId },
    } satisfies RpcSessionEvent);
    this.#context.replay.moveStream(entry.stream, rpcSessionEventStream(identity.threadId));
    this.#aliases.set(current, identity.threadId);
    this.#entries.delete(current);
    entry.bootstrap = {
      ...entry.bootstrap,
      threadId: identity.threadId,
      sessionFile: identity.sessionFile,
    };
    entry.stream = rpcSessionEventStream(identity.threadId);
    this.#entries.set(identity.threadId, entry);
  }

  #processOptions(bootstrap: ThreadBootstrap): OmpProcessOptions {
    return {
      threadId: bootstrap.threadId,
      folder: bootstrap.folderPath,
      args: bootstrap.args,
    };
  }

  #openResult(entry: ThreadEntry) {
    return {
      threadId: entry.bootstrap.threadId,
      sessionFile: entry.bootstrap.sessionFile,
      capabilities: capabilitiesForProtocol(
        this.#context.capabilities,
        entry.session.protocolVersion,
      ),
    };
  }

  #addViewer(entry: ThreadEntry, connectionId: string): void {
    entry.viewers.set(connectionId, (entry.viewers.get(connectionId) ?? 0) + 1);
  }

  /** Forgets an entry whose open failed, and lets go of the process it acquired. */
  #dropEntry(entry: ThreadEntry): void {
    this.#forget(entry);
    this.#context.processRegistry.release(entry.bootstrap.threadId);
  }

  #forget(entry: ThreadEntry): void {
    entry.unsubscribeEvents();
    const current = entry.bootstrap.threadId;
    this.#entries.delete(current);
    for (const [alias, target] of this.#aliases) {
      if (alias === current || target === current) this.#aliases.delete(alias);
    }
  }

  /**
   * The registry is stopping an unwatched thread's process: the entry that held it can't serve
   * again, so the next open builds a fresh one (and resumes the session file) instead of finding
   * a dead process.
   */
  #forgetStopped(threadId: ThreadId, process: OmpProcess): void {
    const entry = this.#entryOrUndefined(threadId);
    if (entry !== undefined && entry.process === process) this.#forget(entry);
  }

  /** Whether omp says the thread is idle; a thread nothing holds counts as idle. */
  async #isSettled(threadId: ThreadId): Promise<boolean> {
    const entry = this.#entryOrUndefined(threadId);
    if (entry === undefined) return true;
    return readSettled(await entry.session.send({ type: "get_state" }));
  }

  #preference(entry: ThreadEntry, connectionId: string): ViewerPreference {
    return (
      entry.preferences.get(connectionId) ?? {
        level: "off",
        events: null,
        messageUpdates: undefined,
      }
    );
  }

  async #arbitrate(entry: ThreadEntry, signal: AbortSignalLike): Promise<void> {
    const work = entry.arbitration.then(async () => {
      let level: ViewerPreference["level"] = "off";
      let events: string[] | null = null;
      let messageUpdates: ViewerPreference["messageUpdates"];
      const preferences = [...entry.preferences.values()];
      if (preferences.length > 0) {
        level = preferences.reduce(
          (best, preference) =>
            LEVEL_RANK[preference.level] > LEVEL_RANK[best] ? preference.level : best,
          "off" as ViewerPreference["level"],
        );
        const eventSets = preferences.map((preference) => preference.events);
        events = eventSets.some((value) => value === null)
          ? null
          : [...new Set(eventSets.flatMap((value) => value ?? []))];
        messageUpdates = preferences.some((value) => value.messageUpdates === "full")
          ? "full"
          : preferences.some((value) => value.messageUpdates === "delta")
            ? "delta"
            : undefined;
      }
      const eventFilterChanged =
        entry.appliedEvents === undefined ||
        JSON.stringify(entry.appliedEvents) !== JSON.stringify(events) ||
        entry.appliedMessageUpdates !== messageUpdates;
      if (entry.appliedLevel !== level) {
        await entry.session.setSubagentSubscription(level, { signal });
        entry.appliedLevel = level;
      }
      if (eventFilterChanged) {
        await entry.session.setEventFilter(events, messageUpdates, { signal });
        entry.appliedEvents = events;
        entry.appliedMessageUpdates = messageUpdates;
      }
    });
    entry.arbitration = work.catch(() => undefined);
    await work;
  }

  #appliedLevel(entry: ThreadEntry): ViewerPreference["level"] {
    return entry.appliedLevel ?? "off";
  }
}

export interface RpcSessionPortRegistration {
  readonly port: typeof RpcSessionPortContract;
  readonly runtime: RpcSessionPortRuntime;
}

export function createRpcSessionPortRuntime(context: A0PortContext): RpcSessionPortRegistration {
  const runtime = new RpcSessionPortRuntime(context);
  return { port: RpcSessionPort, runtime };
}
