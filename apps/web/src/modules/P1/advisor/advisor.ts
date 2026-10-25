import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CommandRunResult,
  type ConfigEntry,
  type ConfigSource,
  ConfigStore,
  type FolderPath,
  type JsonValue,
  OmpCommandGateway,
  type Revision,
  type SlashCommand,
  type ThreadId,
} from "@omp-app/contracts";
export type AdvisorConfigLayer = "global" | "project";

/**
 * omp v18.12.6 declares these eight settings in
 * `packages/coding-agent/src/advisor/settings.ts:10-163`, under the model/Advisor group (`advisor.continueSeverity` is
 * the one added after v18.9.1, at `:65-84`). The browser uses their plain-English labels in `model.ts`; these keys stay
 * in the typed ConfigStore seam and never appear as UI copy.
 */
export const ADVISOR_KEYS = [
  "advisor.enabled",
  "advisor.syncBacklog",
  "advisor.immuneTurns",
  "advisor.continueSeverity",
  "advisor.reviewMode",
  "advisor.reviewInterval",
  "advisor.maxNotesPerUpdate",
  "advisor.evictStaleResults",
] as const;

export type AdvisorKey = (typeof ADVISOR_KEYS)[number];

/**
 * The setting is a string enum in omp's v18.9.1 `advisor/settings.ts:26-40`.
 * `advisor/config.ts:49-67` also accepts numeric thresholds only for WATCHDOG
 * roster entries, not for this setting.
 */
const ADVISOR_SYNC_BACKLOG_VALUES = ["off", "1", "3", "5", "strict"] as const;
const ADVISOR_REVIEW_MODE_VALUES = ["turn", "agent-end"] as const;
/** `ADVISOR_SEVERITIES`, weakest first (packages/tui/src/chat/messages.ts:290 at v18.12.6). */
const ADVISOR_CONTINUE_SEVERITY_VALUES = ["nit", "concern", "blocker"] as const;
const ADVISOR_VALUE_VALIDATORS: Readonly<Record<AdvisorKey, (value: JsonValue) => boolean>> = {
  "advisor.enabled": (value) => typeof value === "boolean",
  "advisor.syncBacklog": (value) =>
    typeof value === "string" &&
    ADVISOR_SYNC_BACKLOG_VALUES.includes(value as (typeof ADVISOR_SYNC_BACKLOG_VALUES)[number]),
  "advisor.reviewMode": (value) =>
    typeof value === "string" &&
    ADVISOR_REVIEW_MODE_VALUES.includes(value as (typeof ADVISOR_REVIEW_MODE_VALUES)[number]),
  "advisor.immuneTurns": (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0,
  "advisor.maxNotesPerUpdate": (value) =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1,
  "advisor.reviewInterval": (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1,
  "advisor.continueSeverity": (value) =>
    typeof value === "string" &&
    ADVISOR_CONTINUE_SEVERITY_VALUES.includes(
      value as (typeof ADVISOR_CONTINUE_SEVERITY_VALUES)[number],
    ),
  "advisor.evictStaleResults": (value) => typeof value === "boolean",
};

function validateAdvisorValue(key: AdvisorKey, value: JsonValue): void {
  if (ADVISOR_VALUE_VALIDATORS[key](value)) return;
  throw new AppFailure({
    code: "invalid_args",
    message: "That advisor setting value is not valid.",
    retryable: false,
  });
}

export type AdvisorCommand = "toggle" | "on" | "off" | "status" | "dump";

/**
 * omp v18.9.1 registers `/advisor` and these subcommands in
 * `packages/coding-agent/src/slash-commands/builtin-collaboration.ts:63-75`.
 * Its RPC handler returns typed command output through A1; the browser never parses
 * that human-facing text.
 */
const ADVISOR_COMMANDS: Readonly<Record<AdvisorCommand, SlashCommand>> = {
  toggle: "/advisor toggle" as SlashCommand,
  on: "/advisor on" as SlashCommand,
  off: "/advisor off" as SlashCommand,
  status: "/advisor status" as SlashCommand,
  dump: "/advisor dump" as SlashCommand,
};

export function advisorCommand(command: AdvisorCommand): SlashCommand {
  return ADVISOR_COMMANDS[command];
}

export interface AdvisorCommandSource {
  readonly run: (command: AdvisorCommand) => Promise<CommandRunResult>;
}

export function createAdvisorCommandSource(
  client: AppClient,
  threadId: ThreadId,
): AdvisorCommandSource {
  const gateway = client.port(OmpCommandGateway);
  return { run: (command) => gateway.run({ threadId, command: advisorCommand(command) }) };
}

export type AdvisorCommandState =
  | { readonly status: "idle"; readonly result: null; readonly error: null }
  | { readonly status: "running"; readonly result: null; readonly error: null }
  | { readonly status: "completed"; readonly result: CommandRunResult; readonly error: null }
  | { readonly status: "error"; readonly result: null; readonly error: AppFailure };

export interface AdvisorCommandController {
  readonly getSnapshot: () => AdvisorCommandState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly run: (command: AdvisorCommand) => Promise<CommandRunResult | undefined>;
  readonly dispose: () => void;
}

export function createAdvisorCommandController(
  source: AdvisorCommandSource,
): AdvisorCommandController {
  let snapshot: AdvisorCommandState = { status: "idle", result: null, error: null };
  const listeners = new Set<() => void>();
  let disposed = false;
  let inFlight = false;
  const publish = (next: AdvisorCommandState): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run: async (command) => {
      if (disposed)
        throw new AppFailure({
          code: "cancelled",
          message: "Advisor commands are closed.",
          retryable: false,
        });
      if (inFlight) return undefined;
      inFlight = true;
      publish({ status: "running", result: null, error: null });
      try {
        try {
          const result = await source.run(command);
          publish({ status: "completed", result, error: null });
          return result;
        } catch (error) {
          const failure =
            error instanceof AppFailure
              ? error
              : new AppFailure(
                  { code: "omp_error", message: "The advisor command failed.", retryable: true },
                  { cause: error },
                );
          publish({ status: "error", result: null, error: failure });
          throw failure;
        }
      } finally {
        inFlight = false;
      }
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}

export interface AdvisorConfigEntry {
  readonly key: AdvisorKey;
  readonly value: ConfigEntry;
}

export type AdvisorConfigPhase = "idle" | "loading" | "ready" | "saving" | "conflict" | "error";

export interface AdvisorConfigState {
  readonly phase: AdvisorConfigPhase;
  readonly entries: readonly AdvisorConfigEntry[];
  readonly layer: AdvisorConfigLayer;
  readonly revision: Revision;
  readonly error: AppFailure | null;
}

export interface AdvisorConfigController {
  readonly getSnapshot: () => AdvisorConfigState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: () => Promise<AdvisorConfigState>;
  readonly write: (key: AdvisorKey, value: JsonValue) => Promise<AdvisorConfigState>;
  readonly dispose: () => void;
}

export interface AdvisorConfigControllerOptions {
  readonly folder: FolderPath | null;
  readonly layer: AdvisorConfigLayer;
}

function advisorEntries(entries: readonly ConfigEntry[]): AdvisorConfigEntry[] {
  return entries.flatMap((value) => {
    if (!ADVISOR_KEYS.includes(value.key as AdvisorKey)) return [];
    return [{ key: value.key as AdvisorKey, value }];
  });
}

function asFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({ code: "internal", message: fallback, retryable: true }, { cause: error });
}

function disposedFailure(): AppFailure {
  return new AppFailure({
    code: "cancelled",
    message: "Advisor settings are closed.",
    retryable: false,
  });
}

export function createAdvisorConfigController(
  client: AppClient,
  options: AdvisorConfigControllerOptions,
): AdvisorConfigController {
  if (options.layer !== "global" && options.layer !== "project") {
    throw new AppFailure({
      code: "invalid_args",
      message: "Advisor settings can only be stored in the global or project layer.",
      retryable: false,
    });
  }
  if (options.layer === "project" && options.folder === null) {
    throw new AppFailure({
      code: "invalid_args",
      message: "A workspace folder is needed for project advisor settings.",
      retryable: false,
    });
  }
  const config = client.port(ConfigStore);
  const listeners = new Set<() => void>();
  let disposed = false;
  let subscription: { readonly unsubscribe: () => Promise<void> } | undefined;
  let removeListener: (() => void) | undefined;
  let state: AdvisorConfigState = {
    phase: "idle",
    entries: [],
    layer: options.layer,
    revision: "advisor-initial" as Revision,
    error: null,
  };
  const publish = (patch: Partial<AdvisorConfigState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const read = async (): Promise<AdvisorConfigState> => {
    if (disposed) throw disposedFailure();
    publish({ phase: "loading", error: null });
    try {
      const result = await config.list({
        prefix: "advisor",
        folder: options.layer === "project" ? options.folder : null,
      });
      if (disposed) throw disposedFailure();
      publish({
        phase: "ready",
        entries: advisorEntries(result.entries),
        revision: result.revision,
        error: null,
      });
    } catch (error) {
      const failure = asFailure(error, "Advisor settings could not be read.");
      if (!disposed) publish({ phase: "error", error: failure });
      throw failure;
    }
    return state;
  };
  const write = async (key: AdvisorKey, value: JsonValue): Promise<AdvisorConfigState> => {
    if (disposed) throw disposedFailure();
    validateAdvisorValue(key, value);
    publish({ phase: "saving", error: null });
    try {
      const result = await config.write({
        key,
        layer: options.layer,
        folder: options.layer === "project" ? options.folder : null,
        value: { secret: false, value },
        expectedRevision: state.revision,
      });
      if (disposed) throw disposedFailure();
      const entries = state.entries.filter((entry) => entry.key !== key);
      publish({
        phase: "ready",
        entries: [...entries, { key, value: result.entry }],
        revision: result.revision,
        error: null,
      });
    } catch (error) {
      const failure = asFailure(error, "Advisor settings could not be saved.");
      if (!disposed) {
        publish({
          phase: failure.appError.code === "conflict" ? "conflict" : "error",
          error: failure,
        });
      }
      throw failure;
    }
    return state;
  };
  const startSubscription = (): void => {
    void client
      .subscribe(ConfigStore, "changed", { scope: options.folder ?? undefined })
      .then((next) => {
        subscription = next;
        if (disposed) {
          void next.unsubscribe();
          return;
        }
        removeListener = next.onEvent((change) => {
          if (!disposed && ADVISOR_KEYS.includes(change.key as AdvisorKey)) void read();
        });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          publish({
            phase: "error",
            error: asFailure(error, "Advisor settings could not watch for changes."),
          });
        }
      });
  };
  startSubscription();
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    write,
    dispose: () => {
      disposed = true;
      removeListener?.();
      void subscription?.unsubscribe();
      listeners.clear();
    },
  };
}

export function advisorEntryValue(entry: AdvisorConfigEntry | undefined): JsonValue | undefined {
  const value = entry?.value;
  return value === undefined || value.secret ? undefined : value.value;
}

export function advisorSource(entry: AdvisorConfigEntry | undefined): ConfigSource | undefined {
  return entry?.value.source;
}
