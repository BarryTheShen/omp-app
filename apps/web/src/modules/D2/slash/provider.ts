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
import type {
  SlashCommand,
  TriggerPosition,
  TriggerProvider,
  TriggerSearchResult,
} from "../contract";
import { createSlashCommandCatalog, type SlashCommandCatalogController } from "./catalog";
import { rankSlashEntries, type SlashListEntry } from "./rank";
import {
  guardedRoute,
  routeSlashText,
  type SlashAppCommand,
  type SlashRoute,
  type TerminalOnlyNote,
  terminalOnlyNote,
} from "./routing";

export interface SlashCommandProviderOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  /** Read when the list is searched or a submit is routed, so a capability change applies at once. */
  readonly capabilities?: () => CapabilityMap;
  /** Injected for tests; when absent the provider owns and disposes its own catalog. */
  readonly catalog?: SlashCommandCatalogController;
  /** The commands the app runs itself, read at each use so a new handler never rebuilds the provider. */
  readonly appCommands?: () => readonly SlashAppCommand[];
}

export interface SlashCommandProvider extends TriggerProvider {
  readonly catalog: SlashCommandCatalogController;
  /** Decides where a submitted message goes: a known command, or null for a normal prompt. */
  readonly route: (text: string) => Promise<SlashRoute | null>;
  /** The note for a typed name that only omp's terminal runs (`/clear`), or null: a listed row with that name hides it. */
  readonly terminalOnlyNote: (query: string) => Promise<TerminalOnlyNote | null>;
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

  /**
   * omp's commands, minus each one that a listed app command of the same name or alias replaces. An unlisted app command (a
   * guarded form such as `wt`) keeps omp's row: typing the form still runs the app's, because `guardedRoute` runs first.
   */
  const listEntries = (): readonly SlashListEntry[] => {
    const listedNames = new Set(
      (options.appCommands?.() ?? [])
        .filter((app) => app.unlisted !== true)
        .flatMap((app) => [app.name, ...(app.aliases ?? [])]),
    );
    return catalog
      .getSnapshot()
      .commands.filter((command) => !listedNames.has(command.name))
      .map(commandToEntry);
  };

  const appEntries = (): readonly SlashListEntry[] =>
    (options.appCommands?.() ?? [])
      .filter((app) => app.unlisted !== true)
      .map((app) => ({
        name: app.name,
        source: "client",
        description: app.description,
        ...(app.aliases === undefined ? {} : { aliases: app.aliases }),
      }));

  const searchTyped = async (
    query: string,
    position?: TriggerPosition,
  ): Promise<TriggerSearchResult> => {
    await ensureCatalog();
    const snapshot = catalog.getSnapshot();
    const entries = [...listEntries(), ...appEntries()];
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
    const snapshot = catalog.getSnapshot();
    if (snapshot.state !== "ready" && snapshot.commands.length === 0) {
      return routeWithoutList(text, appCommands, snapshot.error?.error.message);
    }
    return routeSlashText(text, listEntries(), appCommands);
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

  /**
   * The note for a typed name that only omp's terminal runs, or null. A listed row with that name or alias takes the
   * name instead: that row is the command (a user's own `/plan` file command, for example).
   */
  const noteFor = async (query: string): Promise<TerminalOnlyNote | null> => {
    const typed = query.replace(/^\/+/u, "");
    const note = terminalOnlyNote(typed);
    if (note === null) return null;
    await ensureCatalog();
    const listed = [...listEntries(), ...appEntries()];
    const taken = listed.some(
      (entry) => entry.name === typed || (entry.aliases ?? []).includes(typed),
    );
    return taken ? null : note;
  };

  return {
    trigger: "/",
    kind: "slash",
    source: "builtin",
    search: async (query) => (await searchTyped(query)).candidates,
    searchTyped,
    terminalOnlyNote: noteFor,
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

/**
 * Routes a message while omp's list cannot be read, so the app cannot tell a command from text. The app's own answers
 * need no list and still route. Any other `/word` fails with the reason, so the composer keeps it and omp never sees it:
 * a submit never routes on an empty list. A bare slash, or a space after it, is plain text.
 */
function routeWithoutList(
  text: string,
  appCommands: readonly SlashAppCommand[],
  reason: string | undefined,
): SlashRoute | null {
  const answered = routeSlashText(text, [], appCommands);
  if (answered !== null) return answered;
  const word = /^\/(\S+)/u.exec(text)?.[1];
  if (word === undefined) return null;
  throw new AppFailure({
    code: "unavailable",
    message: `/${word} wasn't sent because omp's command list could not be read. ${reason ?? "Slash commands could not be loaded."}`,
    retryable: true,
  });
}
