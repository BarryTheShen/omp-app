import type { AppClient } from "@omp-app/client";
import { AppFailure, McpCommandsPort, type PortClient, type ThreadId } from "@omp-app/contracts";
import {
  I1_CAPABILITIES,
  type McpPortCallOptions,
  type McpPromptCatalog,
  McpPromptInvokeArgs,
  type McpPromptInvokeArgs as McpPromptInvokeArgsValue,
  type McpPromptSummary as McpPromptSummaryValue,
  type McpResourceSummary as McpResourceSummaryValue,
  toI1Failure,
} from "../contract";
import { createMcpServerPort, type McpServerLifecyclePort } from "../servers";

/** The v18.12.6 command surface lists prompts but does not fetch their message content. */
const MCP_PROMPT_EXPANSION_CAPABILITY = "upstream.mcp-prompt-expansion" as const;

export type McpCatalogState = "idle" | "loading" | "ready" | "stale" | "error" | "unavailable";

export interface McpCatalogSnapshot<T> {
  readonly state: McpCatalogState;
  readonly entries: readonly T[];
  readonly revision: string | null;
  readonly serverRevision: string | null;
  readonly truncated: boolean;
  readonly skippedCount: number;
  readonly refreshedAt: number | null;
  readonly error: AppFailure["appError"] | null;
}

export interface McpCatalogController<T> {
  getSnapshot(): McpCatalogSnapshot<T>;
  subscribe(listener: (snapshot: McpCatalogSnapshot<T>) => void): () => void;
  refresh(options?: McpPortCallOptions): Promise<readonly T[]>;
  dispose(): void;
}

export interface McpPromptCatalogController
  extends McpCatalogController<McpPromptSummaryValue>,
    McpPromptCatalog {}

export interface McpResourceCatalog extends McpCatalogController<McpResourceSummaryValue> {
  list(options?: McpPortCallOptions): Promise<readonly McpResourceSummaryValue[]>;
}

export interface McpNotificationSnapshot {
  readonly state: "unavailable";
  readonly capability: "upstream.mcp-notifications";
  readonly reason: string;
}

export interface McpProtocolCatalogs {
  readonly servers: McpServerLifecyclePort;
  readonly prompts: McpPromptCatalogController;
  readonly resources: McpResourceCatalog;
  readonly notifications: McpNotificationSnapshot;
  /** Disposes browser catalogs; A0 owns registration sets until the thread or client connection closes. */
  dispose(): void;
}

export interface McpProtocolCatalogOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
}

/** omp v18.12.6 exposes no MCP notification subscription through the app server. */
const MCP_NOTIFICATIONS: McpNotificationSnapshot = Object.freeze({
  state: "unavailable",
  capability: "upstream.mcp-notifications",
  reason: "Live MCP updates are only available in the omp terminal.",
});

interface CatalogRead<T> {
  readonly entries: readonly T[];
  readonly serverRevision: string;
  readonly truncated: boolean;
  readonly skippedCount: number;
}

interface ServerCatalogSnapshot {
  readonly servers: readonly { readonly name: string; readonly enabled: boolean }[];
  readonly revision: string;
  readonly truncated: boolean;
  readonly skippedCount: number;
}

type CatalogReader<T> = (
  options?: McpPortCallOptions,
  serverSnapshot?: ServerCatalogSnapshot,
) => Promise<CatalogRead<T>>;

interface InternalCatalogController<T> extends McpCatalogController<T> {
  refreshWithServerSnapshot(
    options: McpPortCallOptions | undefined,
    serverSnapshot: ServerCatalogSnapshot,
  ): Promise<readonly T[]>;
}

/** Creates the prompt and resource catalogs from the typed A1 MCP command port. */
export function createMcpProtocolCatalogs(options: McpProtocolCatalogOptions): McpProtocolCatalogs {
  const servers = createMcpServerPort(options.client, options.threadId);
  const commands = options.client.port(McpCommandsPort);
  const runExclusive = createCommandQueue();
  const readPrompts = (callOptions?: McpPortCallOptions, serverSnapshot?: ServerCatalogSnapshot) =>
    readCatalogCommand({
      kind: "prompts",
      threadId: options.threadId,
      servers,
      commands,
      runExclusive,
      options: callOptions,
      serverSnapshot,
    });
  const readResources = (
    callOptions?: McpPortCallOptions,
    serverSnapshot?: ServerCatalogSnapshot,
  ) =>
    readCatalogCommand({
      kind: "resources",
      threadId: options.threadId,
      servers,
      commands,
      runExclusive,
      options: callOptions,
      serverSnapshot,
    });
  const prompts = createCatalogController(
    readPrompts,
    "The MCP prompt list could not be refreshed.",
  );
  const resources = createCatalogController(
    readResources,
    "The MCP resource list could not be refreshed.",
  );
  const { refreshWithServerSnapshot: refreshPromptsWithServerSnapshot, ...promptController } =
    prompts;
  const { refreshWithServerSnapshot: refreshResourcesWithServerSnapshot, ...resourceController } =
    resources;

  return {
    servers,
    prompts: {
      ...promptController,
      async list(callOptions) {
        const serverSnapshot = await servers.list(undefined, callOptions);
        const current = prompts.getSnapshot();
        if (current.state === "ready" && current.serverRevision === serverSnapshot.revision) {
          return current.entries;
        }
        return refreshPromptsWithServerSnapshot(callOptions, serverSnapshot);
      },
      async invoke(args: McpPromptInvokeArgsValue, _callOptions?: McpPortCallOptions) {
        const parsed = McpPromptInvokeArgs.safeParse(args);
        if (!parsed.success) {
          throw new AppFailure({
            code: "invalid_args",
            message: "Choose a valid MCP prompt.",
            retryable: false,
          });
        }
        throw new AppFailure({
          code: "unavailable",
          message: "The omp terminal can fetch MCP prompt content; this app can only list prompts.",
          retryable: false,
          capability: MCP_PROMPT_EXPANSION_CAPABILITY,
        });
      },
    },
    resources: {
      ...resourceController,
      async list(callOptions) {
        const serverSnapshot = await servers.list(undefined, callOptions);
        const current = resources.getSnapshot();
        if (current.state === "ready" && current.serverRevision === serverSnapshot.revision) {
          return current.entries;
        }
        return refreshResourcesWithServerSnapshot(callOptions, serverSnapshot);
      },
    },
    notifications: MCP_NOTIFICATIONS,
    dispose() {
      prompts.dispose();
      resources.dispose();
    },
  };
}

interface ReadCatalogOptions {
  readonly kind: "prompts" | "resources";
  readonly threadId: ThreadId;
  readonly servers: McpServerLifecyclePort;
  readonly commands: PortClient<typeof McpCommandsPort>;
  readonly runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly options?: McpPortCallOptions;
  readonly serverSnapshot?: ServerCatalogSnapshot;
}

async function readCatalogCommand(
  options: ReadCatalogOptions & { readonly kind: "prompts" },
): Promise<CatalogRead<McpPromptSummaryValue>>;
async function readCatalogCommand(
  options: ReadCatalogOptions & { readonly kind: "resources" },
): Promise<CatalogRead<McpResourceSummaryValue>>;
async function readCatalogCommand(
  options: ReadCatalogOptions,
): Promise<CatalogRead<McpPromptSummaryValue> | CatalogRead<McpResourceSummaryValue>> {
  return options.runExclusive(async () => {
    const serverSnapshot =
      options.serverSnapshot ?? (await options.servers.list(undefined, options.options));
    const enabledServers = new Set(
      serverSnapshot.servers.filter((server) => server.enabled).map((server) => server.name),
    );
    if (enabledServers.size === 0) {
      return {
        entries: [],
        serverRevision: serverSnapshot.revision,
        truncated: serverSnapshot.truncated,
        skippedCount: serverSnapshot.skippedCount,
      };
    }

    if (options.kind === "prompts") {
      const result = await options.commands.prompts(
        { threadId: options.threadId },
        options.options,
      );
      return {
        entries: result.prompts.filter((prompt) => enabledServers.has(prompt.server)),
        serverRevision: serverSnapshot.revision,
        truncated: serverSnapshot.truncated || result.truncated,
        skippedCount: serverSnapshot.skippedCount + result.skippedCount,
      };
    }
    const result = await options.commands.resources(
      { threadId: options.threadId },
      options.options,
    );
    return {
      entries: result.resources.filter((resource) => enabledServers.has(resource.server)),
      serverRevision: serverSnapshot.revision,
      truncated: serverSnapshot.truncated || result.truncated,
      skippedCount: serverSnapshot.skippedCount + result.skippedCount,
    };
  });
}

function stableIdentifier(prefix: string, value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}-${hash.toString(16).padStart(16, "0")}`;
}

function createCatalogController<T>(
  read: CatalogReader<T>,
  fallbackMessage: string,
): InternalCatalogController<T> {
  const listeners = new Set<(snapshot: McpCatalogSnapshot<T>) => void>();
  let disposed = false;
  let inFlight: Promise<readonly T[]> | undefined;
  let snapshot: McpCatalogSnapshot<T> = Object.freeze({
    state: "idle",
    entries: Object.freeze([]),
    revision: null,
    serverRevision: null,
    truncated: false,
    skippedCount: 0,
    refreshedAt: null,
    error: null,
  });

  const emit = (next: McpCatalogSnapshot<T>): void => {
    if (disposed) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener(snapshot);
  };
  const refreshInternal = (
    callOptions: McpPortCallOptions | undefined,
    serverSnapshot?: ServerCatalogSnapshot,
  ): Promise<readonly T[]> => {
    if (disposed) {
      return Promise.reject(
        new AppFailure({
          code: "unavailable",
          message: "This MCP catalog is no longer active.",
          retryable: false,
          capability: I1_CAPABILITIES.mcp,
        }),
      );
    }
    if (inFlight) return waitForSignal(inFlight, callOptions?.signal);

    const previous = snapshot;
    emit({ ...previous, state: "loading", error: null });
    const pending = (async (): Promise<readonly T[]> => {
      try {
        const result = await read(undefined, serverSnapshot);
        const entries = Object.freeze([...result.entries]);
        const revision = stableIdentifier(
          "mcp-catalog",
          JSON.stringify({
            serverRevision: result.serverRevision,
            entries,
            truncated: result.truncated,
            skippedCount: result.skippedCount,
          }),
        );
        emit({
          state: "ready",
          entries,
          revision,
          serverRevision: result.serverRevision,
          truncated: result.truncated,
          skippedCount: result.skippedCount,
          refreshedAt: Date.now(),
          error: null,
        });
        return entries;
      } catch (error) {
        const failure = toI1Failure(error, fallbackMessage);
        const state: McpCatalogState =
          previous.refreshedAt !== null
            ? "stale"
            : failure.appError.code === "unavailable"
              ? "unavailable"
              : "error";
        emit({ ...previous, state, error: failure.appError });
        throw failure;
      } finally {
        inFlight = undefined;
      }
    })();
    inFlight = pending;
    return waitForSignal(pending, callOptions?.signal);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    refresh: (callOptions) => refreshInternal(callOptions),
    refreshWithServerSnapshot: refreshInternal,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    return Promise.reject(
      new AppFailure({
        code: "cancelled",
        message: "The MCP catalog refresh was cancelled.",
        retryable: false,
        capability: I1_CAPABILITIES.mcp,
      }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => {
      signal.removeEventListener("abort", cancelled);
      reject(
        new AppFailure({
          code: "cancelled",
          message: "The MCP catalog refresh was cancelled.",
          retryable: false,
          capability: I1_CAPABILITIES.mcp,
        }),
      );
    };
    signal.addEventListener("abort", cancelled, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", cancelled);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancelled);
        reject(error);
      },
    );
  });
}

function createCommandQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}
