import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type CommandRunResult,
  OmpCommandGateway,
  type PortCallOptions,
  SlashCommand as SlashCommandText,
  type ThreadId,
} from "@omp-app/contracts";
import type { McpPromptCatalog, McpPromptSummary } from "../../I1/contract";
import type {
  SlashCommand,
  TriggerPosition,
  TriggerProvider,
  TriggerSearchResult,
} from "../contract";
import { createSlashCommandCatalog, type SlashCommandCatalogController } from "./catalog";
import { rankSlashEntries, type SlashListEntry } from "./rank";
import { guardedRoute, routeSlashText, type SlashAppCommand, type SlashRoute } from "./routing";

export interface SlashCommandProviderOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  /** Read when the list is searched or a submit is routed, so a capability change applies at once. */
  readonly capabilities?: () => CapabilityMap;
  /** Injected for tests; when absent the provider owns and disposes its own catalog. */
  readonly catalog?: SlashCommandCatalogController;
  /** I1's MCP prompt catalog. omp already lists these as `mcp_prompt`; a prompt listed twice shows once. */
  readonly promptCatalog?: McpPromptCatalog;
  /** The commands the app runs itself, read at each use so a new handler never rebuilds the provider. */
  readonly appCommands?: () => readonly SlashAppCommand[];
}

export interface SlashCommandProvider extends TriggerProvider {
  readonly catalog: SlashCommandCatalogController;
  /** Decides where a submitted message goes: a known command, or null for a normal prompt. */
  readonly route: (text: string) => Promise<SlashRoute | null>;
  /** Runs an omp command through A1's gateway. The result carries omp's output and whether the model ran. */
  readonly execute: (command: string, options?: PortCallOptions) => Promise<CommandRunResult>;
  readonly dispose: () => void;
}

/** Creates the `/` provider. Command execution stays on A1's typed gateway; the browser never reads omp's prose. */
export function createSlashCommandProvider(
  options: SlashCommandProviderOptions,
): SlashCommandProvider {
  const ownsCatalog = options.catalog === undefined;
  const catalog =
    options.catalog ??
    createSlashCommandCatalog({
      client: options.client,
      threadId: options.threadId,
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    });
  const gateway = options.client.port(OmpCommandGateway);
  let loading: Promise<void> | undefined;
  let promptEntries: readonly SlashListEntry[] | undefined;
  let promptLoad: Promise<readonly SlashListEntry[]> | undefined;

  // Waits for the first read, or for a read already in flight, so a submit never routes on an empty list.
  // A ready list is kept current by omp's live frames. Any other state is read again here, so a failed
  // read recovers on the next search or submit; until then the list shows the failure.
  const ensureCatalog = (): Promise<void> => {
    const { state } = catalog.getSnapshot();
    if (state === "ready") return Promise.resolve();
    loading ??= catalog
      .refresh()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };

  const loadPromptEntries = (): Promise<readonly SlashListEntry[]> => {
    if (promptEntries !== undefined || options.promptCatalog === undefined) {
      return Promise.resolve(promptEntries ?? []);
    }
    const promptCatalog = options.promptCatalog;
    promptLoad ??= promptCatalog
      .list()
      .then((prompts) => {
        promptEntries = prompts.map(promptToEntry);
        return promptEntries;
      })
      .catch(() => {
        // Cached as empty: a failing MCP read is not retried on every keystroke. omp's own list still has these prompts.
        promptEntries = [];
        return promptEntries;
      })
      .finally(() => {
        promptLoad = undefined;
      });
    return promptLoad;
  };

  /** omp's commands first, then MCP prompts that omp did not already list. An app command replaces omp's command of the same name. */
  const listEntries = async (): Promise<readonly SlashListEntry[]> => {
    const appNames = new Set((options.appCommands?.() ?? []).map((app) => app.name));
    const fromOmp = catalog
      .getSnapshot()
      .commands.filter((command) => !appNames.has(command.name))
      .map(commandToEntry);
    const seen = new Set(fromOmp.map((entry) => `${entry.source}:${entry.name}`));
    const extra = (await loadPromptEntries()).filter(
      (entry) => !seen.has(`${entry.source}:${entry.name}`),
    );
    return [...fromOmp, ...extra];
  };

  const appEntries = (): readonly SlashListEntry[] =>
    (options.appCommands?.() ?? [])
      .filter((app) => app.unlisted !== true)
      .map((app) => ({
        name: app.name,
        source: "client",
        description: app.description,
      }));

  const searchTyped = async (
    query: string,
    position?: TriggerPosition,
  ): Promise<TriggerSearchResult> => {
    await ensureCatalog();
    const snapshot = catalog.getSnapshot();
    const entries = [...(await listEntries()), ...appEntries()];
    const candidates = rankSlashEntries(entries, query).map((candidate) =>
      position === undefined ? candidate : { ...candidate, position },
    );
    return {
      state: snapshot.state,
      candidates,
      revision: snapshot.revision,
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    };
  };

  const route = async (text: string): Promise<SlashRoute | null> => {
    const appCommands = options.appCommands?.() ?? [];
    // A guarded form is the app's whatever the catalog holds, so it is answered before any catalog read.
    const guarded = guardedRoute(text, appCommands);
    if (guarded !== null) return guarded;
    if (!text.startsWith("/")) return null;
    await ensureCatalog();
    return routeSlashText(text, await listEntries(), appCommands);
  };

  const execute = (command: string, callOptions?: PortCallOptions): Promise<CommandRunResult> => {
    const parsed = SlashCommandText.safeParse(command.trim());
    if (!parsed.success) {
      return Promise.reject(
        new AppFailure({
          code: "invalid_args",
          message: "Enter a slash command before running it.",
          retryable: false,
        }),
      );
    }
    return gateway.run({ threadId: options.threadId, command: parsed.data }, callOptions);
  };

  return {
    trigger: "/",
    kind: "slash",
    source: "builtin",
    search: async (query) => (await searchTyped(query)).candidates,
    searchTyped,
    catalog,
    route,
    execute,
    dispose: () => {
      if (ownsCatalog) catalog.dispose();
    },
  };
}

function commandToEntry(command: SlashCommand): SlashListEntry {
  return command;
}

function promptToEntry(prompt: McpPromptSummary): SlashListEntry {
  return {
    name: `${prompt.server}:${prompt.name}`,
    source: "mcp_prompt",
    ...(prompt.description === undefined ? {} : { description: prompt.description }),
  };
}
