import type { OmpWire, RpcSessionEvent } from "@omp-app/contracts";
import {
  type AbortSignalLike,
  AppFailure,
  type CommandOutput,
  type CommandOutputEvent,
  type CommandRunArgs,
  CommandRunArgs as CommandRunArgsSchema,
  type CommandRunResult,
  type CompactionEvent,
  type ConfigInfoUpdate,
  type SessionInfoUpdate,
  ThreadId,
} from "@omp-app/contracts";
import type { CommandFuture, RpcSession } from "@omp-app/omp-rpc";
import { compactionOutcome } from "./compaction-parser";
import { registerOmpCommandParsers } from "./parsers";

/** Resolves the already-connected RpcSession backing one thread's omp process. */
export type SessionResolver = (threadId: ThreadId) => RpcSession | Promise<RpcSession>;

/** The correlated raw frames of one command run, before any per-command parser is applied. */
export interface CommandParserContext {
  /** The command as run, with its leading `/` and any arguments. */
  readonly command: CommandRunResult["command"];
  /** False when omp sent the text to the model as a prompt, so the outputs are not the command's own. */
  readonly agentInvoked: boolean;
  readonly outputs: readonly CommandOutput[];
  readonly sessionUpdates: readonly SessionInfoUpdate[];
  readonly configUpdates: readonly ConfigInfoUpdate[];
}

export type CommandParser<T> = (context: CommandParserContext) => T | PromiseLike<T>;

/** Mirrors `CommandFuture`: `admitted` resolves at the prompt's admission, before settlement. */
export interface CommandRunFuture extends Promise<CommandRunResult> {
  readonly admitted: Promise<{ readonly agentInvoked: boolean }>;
}

export interface CommandRunOptions {
  readonly signal?: AbortSignalLike;
}

export interface OmpCommandGatewayOptions {
  readonly resolveSession: SessionResolver;
  /** Receives parser failures and other errors that must not crash a caller that ignores them. */
  readonly onError?: (error: AppFailure) => void;
}

type OutputListener = (event: CommandOutputEvent) => void;

type CompactionListener = (event: CompactionEvent) => void;

/** How long a background `/compact` is watched for omp's result. A compaction that never reports is then dropped. */
const COMPACTION_WATCH_MS = 30 * 60 * 1000;

function failure(
  code: "invalid_args" | "unavailable" | "not_found" | "cancelled" | "internal",
  message: string,
  retryable: boolean,
): AppFailure {
  return new AppFailure({ code, message, retryable });
}

function isAppFailure(error: unknown): error is AppFailure {
  return error instanceof AppFailure;
}

function toFailure(error: unknown, operation: string): AppFailure {
  if (isAppFailure(error)) return error;
  return failure("internal", `Cannot ${operation}.`, false);
}

function reportError(callback: OmpCommandGatewayOptions["onError"], error: AppFailure): void {
  if (!callback) return;
  try {
    callback(error);
  } catch {
    // An error observer must never become an uncaught exception.
  }
}

/**
 * The bare command name (no leading `/`, no arguments), read the way omp reads it: up to the first colon, so `force:read`
 * is `force` (parse.ts). It names the typed parser; the catalog check in `run` also accepts the whole first word.
 */
function commandName(command: string): string {
  const withoutSlash = command.slice(1);
  const firstToken = withoutSlash.split(/\s+/, 1)[0];
  return (firstToken ?? "").split(":", 1)[0] ?? "";
}
function parserName(name: string): string {
  const normalized = name.startsWith("/") ? name.slice(1) : name;
  if (normalized.length === 0) throw new Error("Command parser name must not be empty.");
  return normalized;
}

function commandCatalogHas(
  catalog: readonly OmpWire.AvailableSlashCommand[],
  name: string,
): boolean {
  return catalog.some((entry) => entry.name === name || (entry.aliases?.includes(name) ?? false));
}

/** Safe model metadata only: never `headers`, `baseUrl`, `cost` or other provider-identifying data. */
function toCommandModelUpdate(model: OmpWire.ModelInfo): ConfigInfoUpdate["model"] {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    reasoning: model.reasoning,
  };
}

function toConfigInfoUpdate(frame: OmpWire.ConfigUpdateEvent): ConfigInfoUpdate {
  return {
    ...(frame.model === undefined ? {} : { model: toCommandModelUpdate(frame.model) }),
    ...(frame.thinkingLevel === undefined ? {} : { thinkingLevel: frame.thinkingLevel }),
  };
}

function toSessionInfoUpdate(frame: OmpWire.SessionInfoUpdateEvent): SessionInfoUpdate {
  return {
    sessionId: ThreadId.parse(frame.sessionId),
    ...(frame.title === undefined ? {} : { title: frame.title }),
  };
}

function toCommandOutput(frame: OmpWire.CommandOutputEvent): CommandOutput {
  return { text: frame.text };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/** Races one operation against an abort signal without leaving the loser's rejection unhandled. */
function raceAbort<T>(
  signal: AbortSignalLike | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return operation();
  if (signal.aborted)
    return Promise.reject(failure("cancelled", "The command was cancelled.", false));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(failure("cancelled", "The command was cancelled.", false));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation().then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Serializes commands per thread: a queued caller waits its turn, or rejects at once on abort. */
class ThreadCommandQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(
    key: string,
    signal: AbortSignalLike | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const previousTail = this.#tails.get(key) ?? Promise.resolve();
    let releaseTail!: () => void;
    const myTail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const chainedTail = previousTail.then(
      () => myTail,
      () => myTail,
    );
    this.#tails.set(key, chainedTail);
    void chainedTail.then(() => {
      if (this.#tails.get(key) === chainedTail) this.#tails.delete(key);
    });

    const waitForTurn = previousTail.then(
      () => undefined,
      () => undefined,
    );
    try {
      await raceAbort(signal, () => waitForTurn);
    } catch (error) {
      releaseTail();
      throw error;
    }
    if (signal?.aborted === true) {
      releaseTail();
      throw failure("cancelled", "The command was cancelled.", false);
    }
    try {
      return await task();
    } finally {
      releaseTail();
    }
  }
}

/**
 * Runs omp slash commands through A0.3's `RpcSession` prompt lifecycle (AP4). A command is
 * admitted, then settled only once its `prompt_result` arrives (or immediately when
 * `agentInvoked` is false); `command_output`/`session_info_update`/`config_update` frames carry
 * no correlation id, so they are attributed to the one command this gateway allows in flight per
 * thread. Per-command parsers are registered by consumer modules; a command with none registered
 * surfaces its raw correlated frames instead (`runWithParser`).
 */
export class OmpCommandGatewayService {
  readonly #resolveSession: SessionResolver;
  readonly #onError: OmpCommandGatewayOptions["onError"];
  readonly #queue = new ThreadCommandQueue();
  readonly #parsers = new Map<string, CommandParser<unknown>>();
  readonly #outputListeners = new Set<OutputListener>();
  readonly #compactionListeners = new Set<CompactionListener>();

  constructor(options: OmpCommandGatewayOptions) {
    this.#resolveSession = options.resolveSession;
    this.#onError = options.onError;
  }

  /** Registers a typed parser for one bare command name (a leading `/` is accepted for convenience). */
  registerCommandParser<T>(name: string, parser: CommandParser<T>): void {
    const normalizedName = parserName(name);
    if (this.#parsers.has(normalizedName)) {
      throw new Error(`Duplicate command parser registration for ${normalizedName}`);
    }
    this.#parsers.set(normalizedName, parser as CommandParser<unknown>);
  }

  onOutput(listener: OutputListener): () => void {
    this.#outputListeners.add(listener);
    return () => {
      this.#outputListeners.delete(listener);
    };
  }

  /** Listens for the typed outcome of a `/compact` that finished in the background (see `#watchCompaction`). */
  onCompaction(listener: CompactionListener): () => void {
    this.#compactionListeners.add(listener);
    return () => {
      this.#compactionListeners.delete(listener);
    };
  }

  /** Alias used by composition code that names subscriptions explicitly. */
  subscribeOutput(listener: OutputListener): () => void {
    return this.onOutput(listener);
  }

  run(args: CommandRunArgs, options: CommandRunOptions = {}): CommandRunFuture {
    const admittedDeferred = createDeferred<{ agentInvoked: boolean }>();
    void admittedDeferred.promise.catch(() => undefined);
    const resultPromise = this.#run(args, options.signal, admittedDeferred);
    const future = resultPromise as CommandRunFuture;
    Object.defineProperty(future, "admitted", {
      configurable: false,
      enumerable: false,
      value: admittedDeferred.promise,
    });
    return future;
  }

  /** Runs the command, then applies its registered parser; an unparsed command gets raw frames. */
  async runWithParser<T>(
    args: CommandRunArgs,
    options: CommandRunOptions = {},
  ): Promise<{ readonly result: CommandRunResult; readonly data: T | CommandParserContext }> {
    const result = await this.run(args, options);
    const name = commandName(result.command);
    const context: CommandParserContext = {
      command: result.command,
      agentInvoked: result.agentInvoked,
      outputs: result.outputs,
      sessionUpdates: result.sessionUpdates,
      configUpdates: result.configUpdates,
    };
    const parser = this.#parsers.get(parserName(name));
    if (!parser) return { result, data: context };
    try {
      return { result, data: (await parser(context)) as T };
    } catch (cause) {
      // A parser may state its own typed failure, with a message written for the person (an unrecognized
      // reply). Any other throw is a parser bug and gets the generic message.
      const parserFailure = isAppFailure(cause)
        ? cause
        : failure("internal", `Command parser for /${name} threw while parsing its result.`, false);
      reportError(this.#onError, parserFailure);
      throw parserFailure;
    }
  }

  async runParsed<T>(
    args: CommandRunArgs,
    options: CommandRunOptions = {},
  ): Promise<{ readonly result: CommandRunResult; readonly data: T | CommandParserContext }> {
    return this.runWithParser<T>(args, options);
  }

  async #run(
    rawArgs: CommandRunArgs,
    signal: AbortSignalLike | undefined,
    admittedDeferred: Deferred<{ agentInvoked: boolean }>,
  ): Promise<CommandRunResult> {
    let args: CommandRunArgs;
    try {
      args = CommandRunArgsSchema.parse(rawArgs);
    } catch {
      const parseFailure = failure("invalid_args", "Invalid command-run arguments.", false);
      admittedDeferred.reject(parseFailure);
      throw parseFailure;
    }
    if (signal?.aborted === true) {
      const cancelled = failure("cancelled", "The command was cancelled.", false);
      admittedDeferred.reject(cancelled);
      throw cancelled;
    }

    let session: RpcSession;
    try {
      session = await raceAbort(signal, () => Promise.resolve(this.#resolveSession(args.threadId)));
    } catch (cause) {
      const resolveFailure = isAppFailure(cause)
        ? cause
        : failure("not_found", "No running omp session for this thread.", false);
      admittedDeferred.reject(resolveFailure);
      throw resolveFailure;
    }

    const word = args.command.slice(1).split(/\s+/, 1)[0] ?? "";
    const name = commandName(args.command);
    try {
      return await this.#queue.run(args.threadId, signal, async () => {
        await raceAbort(signal, async () => {
          const catalogFuture = session.send({ type: "get_available_commands" }, { signal });
          const catalog = await catalogFuture;
          // omp lists a colon name whole (`github:review`); any other word is read up to its first colon.
          if (
            !commandCatalogHas(catalog.commands, word) &&
            !commandCatalogHas(catalog.commands, name)
          ) {
            throw failure(
              "unavailable",
              `Slash command /${word} is not available in this omp session.`,
              true,
            );
          }
        });
        return this.#sendAndCorrelate(session, args, signal, admittedDeferred);
      });
    } catch (cause) {
      const runFailure = toFailure(cause, "run command");
      admittedDeferred.reject(runFailure);
      throw runFailure;
    }
  }

  async #sendAndCorrelate(
    session: RpcSession,
    args: CommandRunArgs,
    signal: AbortSignalLike | undefined,
    admittedDeferred: Deferred<{ agentInvoked: boolean }>,
  ): Promise<CommandRunResult> {
    const outputs: CommandOutput[] = [];
    const sessionUpdates: SessionInfoUpdate[] = [];
    const configUpdates: ConfigInfoUpdate[] = [];
    let promptResult: OmpWire.PromptResultEvent | undefined;
    let sawSessionSettled = false;

    const unsubscribe = session.onEvent((event: RpcSessionEvent) => {
      try {
        if (event.kind === "notification") {
          if (event.frame.type === "command_output") {
            const output = toCommandOutput(event.frame);
            outputs.push(output);
            this.#emitOutput({ threadId: args.threadId, output });
          } else if (event.frame.type === "session_info_update") {
            sessionUpdates.push(toSessionInfoUpdate(event.frame));
          } else if (event.frame.type === "config_update") {
            configUpdates.push(toConfigInfoUpdate(event.frame));
          }
          return;
        }
        if (event.kind === "prompt_result") {
          promptResult = event.event;
          return;
        }
        if (event.kind === "session_settled") {
          sawSessionSettled = true;
        }
      } catch (cause) {
        reportError(this.#onError, toFailure(cause, "correlate command event"));
      }
    });

    let future: CommandFuture<OmpWire.PromptAck, OmpWire.PromptAck>;
    try {
      future = session.send({ type: "prompt", message: args.command }, { signal });
    } catch (cause) {
      unsubscribe();
      throw toFailure(cause, "send command");
    }
    // omp answers an admitted prompt (and a local command such as an idle `/fresh`) with
    // `{ success: true }` and no `data`, so the acknowledgement can be `undefined`: "agentInvoked"
    // then defaults to true, because the prompt reached the agent unless omp says otherwise.
    future.admitted.then(
      (ack: OmpWire.PromptAck | undefined) =>
        admittedDeferred.resolve({ agentInvoked: ack?.agentInvoked ?? true }),
      admittedDeferred.reject,
    );

    let ack: OmpWire.PromptAck | undefined;
    try {
      ack = await future;
    } catch (cause) {
      unsubscribe();
      throw cause;
    }
    unsubscribe();
    // `/compact` finishes in the background: omp answers the prompt without a turn, then writes the compaction and
    // prints its result later (builtin-lifecycle.ts:259, :250, :252). That result is watched after the run has settled.
    if (ack?.agentInvoked === false && commandName(args.command) === "compact") {
      this.#watchCompaction(session, args.threadId);
    }

    const agentInvoked = ack?.agentInvoked ?? true;
    const status: CommandRunResult["status"] =
      promptResult?.status === "aborted" ? "aborted" : "completed";
    const promptSettled = agentInvoked ? (promptResult?.sessionSettled ?? false) : true;

    return {
      command: args.command,
      status,
      agentInvoked,
      promptSettled,
      sessionSettled: sawSessionSettled,
      outputs,
      sessionUpdates,
      configUpdates,
    };
  }

  #emitOutput(event: CommandOutputEvent): void {
    for (const listener of [...this.#outputListeners]) {
      try {
        listener(event);
      } catch (cause) {
        reportError(this.#onError, toFailure(cause, "deliver command output"));
      }
    }
  }

  /**
   * Watches for the result of a background `/compact` until omp prints it, or until COMPACTION_WATCH_MS passes. The
   * result goes to the compaction listeners as a typed outcome. Nothing waits on the watch: the run has settled, so the
   * thread's command queue is free.
   */
  #watchCompaction(session: RpcSession, threadId: CompactionEvent["threadId"]): void {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => finish(), COMPACTION_WATCH_MS);
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = undefined;
    };
    unsubscribe = session.onEvent((event: RpcSessionEvent) => {
      if (event.kind !== "notification" || event.frame.type !== "command_output") return;
      const outcome = compactionOutcome(event.frame.text);
      if (outcome === undefined) return;
      finish();
      this.#emitCompaction({ threadId, outcome });
    });
    timer.unref?.();
  }

  #emitCompaction(event: CompactionEvent): void {
    for (const listener of [...this.#compactionListeners]) {
      try {
        listener(event);
      } catch (cause) {
        reportError(this.#onError, toFailure(cause, "deliver compaction"));
      }
    }
  }
}

export function createOmpCommandGateway(
  options: OmpCommandGatewayOptions,
): OmpCommandGatewayService {
  const service = new OmpCommandGatewayService(options);
  registerOmpCommandParsers(service);
  return service;
}
