import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  type AbortSignalLike,
  AppFailure,
  type CapabilityMap,
  type PortCallOptions,
  type RpcSessionClient,
  type RpcSessionEvent,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import { z } from "zod";
import {
  SlashCommand,
  SlashCommandCatalog,
  type SlashCommandCatalog as SlashCommandCatalogValue,
  type SlashCommand as SlashCommandValue,
} from "../contract";

const COMMAND_CAPABILITY = "omp.cmd.get_available_commands" as const;
const MAX_COMMANDS = 500;
const MAX_ALIASES = 32;
const MAX_SUBCOMMANDS = 200;
const MAX_TEXT = 2_048;

export interface SlashCommandCatalogOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  /** Read at each refresh, so a later capability change applies without a new catalog. */
  readonly capabilities?: () => CapabilityMap;
}

export interface SlashCommandCatalogController {
  readonly getSnapshot: () => SlashCommandCatalogValue;
  readonly subscribe: (listener: (snapshot: SlashCommandCatalogValue) => void) => () => void;
  readonly refresh: (options?: PortCallOptions) => Promise<readonly SlashCommandValue[]>;
  readonly dispose: () => void;
}

/**
 * omp's slash-command catalog for one chat. It reads `get_available_commands` once and then follows the
 * `available_commands_update` frames omp pushes when its command list changes. A failed read keeps the
 * last good list and records the failure, so the popover can say what went wrong.
 */
export function createSlashCommandCatalog(
  options: SlashCommandCatalogOptions,
): SlashCommandCatalogController {
  const rpc = options.client.port(RpcSessionPort) as RpcSessionClient;
  const listeners = new Set<(snapshot: SlashCommandCatalogValue) => void>();
  let disposed = false;
  let snapshot: SlashCommandCatalogValue = {
    state: "idle",
    commands: [],
    revision: "commands-idle",
  };
  let inFlight: Promise<readonly SlashCommandValue[]> | undefined;
  // Counts live updates. A reply that was requested before a live update may be older than it, so it is ignored.
  let liveUpdates = 0;
  let subscription: AppClientSubscription<RpcSessionEvent> | undefined;
  let subscribing: Promise<void> | undefined;
  let unsubscribeEvents: (() => void) | undefined;

  const emit = (next: SlashCommandCatalogValue): void => {
    if (disposed) return;
    snapshot = SlashCommandCatalog.parse(next);
    for (const listener of [...listeners]) listener(snapshot);
  };

  const applyReady = (rawCommands: unknown): SlashCommandValue[] => {
    const commands = parseCommands(rawCommands);
    emit({ state: "ready", commands, revision: commandRevision(commands) });
    return commands;
  };

  const handleEvent = (payload: RpcSessionEvent): void => {
    if (payload.kind !== "notification" || !isAvailableCommandsUpdate(payload.frame)) return;
    liveUpdates += 1;
    applyReady(payload.frame.commands);
  };

  const ensureSubscription = async (): Promise<void> => {
    if (disposed || subscription !== undefined) return;
    subscribing ??= options.client
      .subscribe(RpcSessionPort, "event", { scope: options.threadId })
      .then((next) => {
        if (disposed) {
          // The catalog was disposed while subscribing; nothing else can release this subscription.
          void next.unsubscribe().catch(() => undefined);
          return;
        }
        subscription = next;
        unsubscribeEvents = next.onEvent(handleEvent);
      })
      .finally(() => {
        subscribing = undefined;
      });
    await subscribing;
  };

  const markFailure = (error: unknown): AppFailure => {
    const failure =
      error instanceof AppFailure
        ? error
        : new AppFailure(
            {
              code: "internal",
              message: "Slash commands could not be loaded.",
              retryable: true,
              capability: COMMAND_CAPABILITY,
            },
            { cause: error },
          );
    const unavailable = failure.appError.code === "unavailable";
    emit({
      state: snapshot.commands.length > 0 ? "stale" : unavailable ? "unavailable" : "error",
      commands: snapshot.commands,
      revision: snapshot.revision,
      error: { state: unavailable ? "unavailable" : "error", error: failure.appError },
    });
    return failure;
  };

  const refresh = (callOptions?: PortCallOptions): Promise<readonly SlashCommandValue[]> => {
    if (disposed) {
      return Promise.reject(
        new AppFailure({
          code: "unavailable",
          message: "The slash-command list is no longer open.",
          retryable: false,
          capability: COMMAND_CAPABILITY,
        }),
      );
    }
    if (
      options.capabilities !== undefined &&
      options.capabilities()[COMMAND_CAPABILITY]?.state !== "available"
    ) {
      const failure = new AppFailure({
        code: "unavailable",
        message: "Slash commands are unavailable in this omp session.",
        retryable: false,
        capability: COMMAND_CAPABILITY,
      });
      markFailure(failure);
      return Promise.reject(failure);
    }
    if (inFlight !== undefined) return waitForSignal(inFlight, callOptions?.signal);

    emit({ ...snapshot, state: "loading", error: undefined });
    const liveAtRequest = liveUpdates;
    const pending = (async (): Promise<readonly SlashCommandValue[]> => {
      try {
        await ensureSubscription();
        const reply = await rpc.send(
          { threadId: options.threadId, command: { type: "get_available_commands" } },
          callOptions,
        );
        if (liveUpdates !== liveAtRequest) return snapshot.commands;
        return applyReady(reply.commands);
      } catch (error) {
        throw markFailure(error);
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = pending;
    return waitForSignal(pending, callOptions?.signal);
  };

  const stopResync = options.client.onResync(() => {
    if (disposed || snapshot.state === "idle") return;
    void refresh().catch(() => undefined);
  });
  const stopConnection = options.client.onConnectionState((event) => {
    if (disposed || event.state !== "open" || snapshot.state === "idle") return;
    void refresh().catch(() => undefined);
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopResync();
      stopConnection();
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
      const current = subscription;
      subscription = undefined;
      if (current !== undefined) void current.unsubscribe().catch(() => undefined);
      listeners.clear();
    },
  };
}

const CommandRecord = z.record(z.string(), z.unknown());
const AvailableCommandsUpdateFrame = z.object({
  type: z.literal("available_commands_update"),
  commands: z.array(z.unknown()),
});

function parseCommands(rawCommands: unknown): SlashCommandValue[] {
  const commands: SlashCommandValue[] = [];
  if (!Array.isArray(rawCommands)) return commands;
  for (const raw of rawCommands.slice(0, MAX_COMMANDS)) {
    const parsed = SlashCommand.safeParse(boundCommand(raw));
    if (parsed.success) commands.push(parsed.data);
  }
  return commands;
}

/** Caps the text omp sends (aliases, subcommands, descriptions) before it reaches the schema. */
function boundCommand(value: unknown): unknown {
  const parsed = CommandRecord.safeParse(value);
  if (!parsed.success) return value;
  const raw = parsed.data;
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .filter((alias): alias is string => typeof alias === "string")
        .slice(0, MAX_ALIASES)
        .map((alias) => alias.slice(0, MAX_TEXT))
    : undefined;
  const subcommands = Array.isArray(raw.subcommands)
    ? raw.subcommands
        .map((subcommand) => CommandRecord.safeParse(subcommand))
        .filter(
          (result): result is { success: true; data: Record<string, unknown> } => result.success,
        )
        .slice(0, MAX_SUBCOMMANDS)
        .map(({ data: item }) => ({
          ...(typeof item.name === "string" ? { name: item.name.slice(0, MAX_TEXT) } : {}),
          ...(typeof item.description === "string"
            ? { description: item.description.slice(0, MAX_TEXT) }
            : {}),
          ...(typeof item.usage === "string" ? { usage: item.usage.slice(0, MAX_TEXT) } : {}),
        }))
    : undefined;
  return {
    ...raw,
    ...(typeof raw.name === "string" ? { name: raw.name.slice(0, MAX_TEXT) } : {}),
    ...(aliases === undefined ? {} : { aliases }),
    ...(typeof raw.description === "string"
      ? { description: raw.description.slice(0, MAX_TEXT) }
      : {}),
    ...(raw.input === undefined ? {} : { input: boundInput(raw.input) }),
    ...(subcommands === undefined ? {} : { subcommands }),
  };
}

function boundInput(value: unknown): unknown {
  const parsed = CommandRecord.safeParse(value);
  if (!parsed.success) return value;
  const hint = parsed.data.hint;
  return typeof hint === "string" ? { hint: hint.slice(0, MAX_TEXT) } : {};
}

function isAvailableCommandsUpdate(
  frame: unknown,
): frame is z.infer<typeof AvailableCommandsUpdateFrame> {
  return AvailableCommandsUpdateFrame.safeParse(frame).success;
}

/** A short fingerprint of the list, so a view can tell that the list changed. */
function commandRevision(commands: readonly SlashCommandValue[]): string {
  let hash = 2_166_136_261;
  const text = JSON.stringify(commands);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return `commands-${hash.toString(16).padStart(8, "0")}`;
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignalLike): Promise<T> {
  const cancelled = (): AppFailure =>
    new AppFailure({
      code: "cancelled",
      message: "Loading slash commands was cancelled.",
      retryable: false,
    });
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  const waiter = Promise.withResolvers<T>();
  const onAbort = (): void => {
    waiter.reject(cancelled());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  promise.then(
    (value) => {
      signal.removeEventListener("abort", onAbort);
      waiter.resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      waiter.reject(error);
    },
  );
  return waiter.promise;
}
