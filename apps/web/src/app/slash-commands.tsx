import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type ModeChangeRequest,
  type ModeChangeResult,
  modeChangeFromCommand,
  type PortCallOptions,
  type RpcSessionSend,
  type ThreadId,
} from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSlashCommandProvider,
  describeCommandResult,
  describeOutputs,
  guardedCommandName,
  guardedRoute,
  plainOutputText,
  type SlashAppCommand,
  type SlashCommandProvider,
  type SlashRoute,
} from "@/modules/D2/slash";
import type { SessionLifecycleController } from "@/modules/D5/lifecycle";
import { modeOutcomeText } from "@/modules/D7/modes";
import { createMcpProtocolCatalogs } from "@/modules/I1/protocol";
import type { PromptIntent } from "@/modules/U2/contract";

/**
 * The slash provider for the open chat. It is built once per chat and disposed when the chat changes.
 * The app's own commands and the capability map are read through getters, so a new handler or a
 * capability change does not rebuild the list.
 */
export function useSlashCommands({
  client,
  threadId,
  capabilities,
  appCommands,
}: {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly appCommands: readonly SlashAppCommand[];
}): SlashCommandProvider | null {
  const getCapabilities = useLatest(capabilities);
  const getAppCommands = useLatest(appCommands);
  const [provider, setProvider] = useState<SlashCommandProvider | null>(null);
  useEffect(() => {
    const catalogs = createMcpProtocolCatalogs({ client, threadId });
    const next = createSlashCommandProvider({
      client,
      threadId,
      capabilities: getCapabilities,
      appCommands: getAppCommands,
      promptCatalog: catalogs.prompts,
    });
    setProvider(next);
    return () => {
      setProvider(null);
      next.dispose();
      catalogs.dispose();
    };
  }, [client, threadId, getCapabilities, getAppCommands]);
  return provider;
}

/** A value readable from a long-lived object: the getter is stable, and it returns the latest value. */
function useLatest<T>(value: T): () => T {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return useCallback(() => ref.current, []);
}

/**
 * `/new`: starts a new chat the way the command palette's New chat does, and opens it. The lifecycle
 * controller and the open-thread action come from the chat that is open.
 */
export function newChatSlashCommand({
  lifecycle,
  openThread,
}: {
  readonly lifecycle: SessionLifecycleController | null;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
}): SlashAppCommand {
  return {
    name: "new",
    description: "Start a new chat",
    run: async () => {
      if (lifecycle === null) {
        throw new AppFailure({
          code: "unavailable",
          message: "Starting a new chat requires a selected workspace folder.",
          retryable: false,
        });
      }
      const outcome = await lifecycle.newSession();
      if (outcome.status === "cancelled") return {};
      if (outcome.status === "completed") {
        await openThread(outcome.value);
        return { message: "Started a new chat." };
      }
      throw new AppFailure(outcome.error);
    },
  };
}

/**
 * `/fresh`: the command palette's Fresh connection action, so typing it asks the same confirmation before
 * omp runs `/fresh`. Without this, a typed `/fresh` would reach omp's builtin directly and skip that step.
 */
export function freshSlashCommand({
  lifecycle,
}: {
  readonly lifecycle: SessionLifecycleController | null;
}): SlashAppCommand {
  return {
    name: "fresh",
    description: "Start a fresh connection to the model",
    run: async ({ signal }) => {
      if (lifecycle === null) {
        throw new AppFailure({
          code: "unavailable",
          message: "Refreshing the model connection is unavailable for this session.",
          retryable: false,
        });
      }
      const outcome = await lifecycle.fresh(signal instanceof AbortSignal ? signal : undefined);
      if (outcome.status === "cancelled") return {};
      if (outcome.status === "completed") {
        const reply = outcome.value.outputs
          .map((output) => plainOutputText(output.text))
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        return { message: reply === "" ? "omp had nothing to say about it." : `omp: ${reply}` };
      }
      throw new AppFailure(outcome.error);
    },
  };
}

/**
 * `/login`: omp's login is not a command omp runs over RPC (its terminal shows a provider picker), so the app
 * opens the provider login page itself, the page Settings > Providers shows. Typed alone, it never reaches omp.
 */
export function loginSlashCommand({
  openLogin,
}: {
  readonly openLogin: () => void;
}): SlashAppCommand {
  return {
    name: "login",
    description: "Log in to a model provider",
    run: async () => {
      openLogin();
      return {};
    },
  };
}

/**
 * `/settings`: omp's settings menu is a terminal dialog; the app opens its own Settings, the one the palette opens.
 */
export function settingsSlashCommand({
  openSettings,
}: {
  readonly openSettings: () => void;
}): SlashAppCommand {
  return {
    name: "settings",
    description: "Open settings",
    run: async () => {
      openSettings();
      return {};
    },
  };
}

/**
 * `/hotkeys`: omp lists its key chords in the terminal; the app opens its shortcut sheet, the same one `?` opens.
 */
export function hotkeysSlashCommand({
  openShortcuts,
}: {
  readonly openShortcuts: () => void;
}): SlashAppCommand {
  return {
    name: "hotkeys",
    description: "Show all keyboard shortcuts",
    run: async () => {
      openShortcuts();
      return {};
    },
  };
}

/**
 * `/share`: the app's own command, in every form (`guardedRoute`). It runs the same flow as the palette command: the
 * question first, naming what is uploaded and where, then the upload. omp's own `/share` never runs unasked.
 */
export function shareSlashCommand({
  run,
}: {
  readonly run: SlashAppCommand["run"];
}): SlashAppCommand {
  return { name: "share", description: "Share this chat as a link", run };
}

/**
 * Decides whether a submitted message is a command. Only a plain prompt can be one: bash and Python input keep their
 * normal path. A guarded form (`/share` in any spelling) is the app's whatever is attached and whether or not the
 * provider is ready, because omp would run its own command on it. Other commands need a plain prompt with nothing
 * attached.
 */
export function routeSubmit({
  intent,
  hasAttachments,
  provider,
  appCommands = [],
}: {
  readonly intent: PromptIntent;
  readonly hasAttachments: boolean;
  readonly provider: SlashCommandProvider | null;
  /** The app's own commands, so a guarded form reaches the app's command of that name. */
  readonly appCommands?: readonly SlashAppCommand[];
}): Promise<SlashRoute | null> {
  if (intent.mode !== "prompt") return Promise.resolve(null);
  const guarded = guardedRoute(intent.text, appCommands);
  if (guarded !== null) return Promise.resolve(guarded);
  if (provider === null || hasAttachments) return Promise.resolve(null);
  if ((intent.images?.length ?? 0) > 0) return Promise.resolve(null);
  return provider.route(intent.text);
}

/** The commands that send text to omp's model or to its command handling. Only these can run a guarded form. */
const SENDS_TEXT_TO_OMP: Record<string, true> = {
  prompt: true,
  steer: true,
  follow_up: true,
  abort_and_prompt: true,
};

/** The text a command sends to omp, when it is one of those commands. */
function textSentToOmp(command: unknown): string | undefined {
  if (typeof command !== "object" || command === null) return undefined;
  const type = "type" in command ? command.type : undefined;
  const message = "message" in command ? command.message : undefined;
  if (typeof type !== "string" || SENDS_TEXT_TO_OMP[type] !== true) return undefined;
  return typeof message === "string" ? message : undefined;
}

/**
 * The send path under every route that is not the composer's own submit (a retry, an edit, a queued message): a
 * guarded form is refused before it leaves the browser. The composer routes these forms to the app first
 * (`routeSubmit`), so this refusal is the net under the other paths.
 */
export function guardOmpSend(send: RpcSessionSend): RpcSessionSend {
  return (args, options) => {
    const text = textSentToOmp(args.command);
    const name = text === undefined ? null : guardedCommandName(text);
    if (name !== null) return Promise.reject(refusedSend(name));
    return send(args, options);
  };
}

/** The refusal for a form of `/share` sent from a retry, an edit or a queued message: those do not ask, so they stop here. */
function refusedSend(name: string): AppFailure {
  return new AppFailure({
    code: "unavailable",
    message: `/${name} runs from the message box or the command palette, so nothing was sent to omp.`,
    retryable: false,
  });
}

/**
 * Runs a routed command. The four mode commands run through the typed gateway, and their status says what omp did in
 * plain words; omp's own words show only for a reply the app does not recognise. Any other finished omp command shows
 * omp's words in the header. A command that fails throws its message, and the composer shows it and keeps the typed
 * text, as it does for any send.
 */
export async function runSlashRoute({
  route,
  intent,
  provider,
  showStatus,
  runMode,
}: {
  readonly route: SlashRoute;
  readonly intent: PromptIntent;
  readonly provider: SlashCommandProvider | null;
  readonly showStatus: (text: string | null) => void;
  /** The typed gateway for the four mode commands; without it they run as any other command. */
  readonly runMode?: (
    request: ModeChangeRequest,
    options: PortCallOptions,
  ) => Promise<ModeChangeResult>;
}): Promise<void> {
  showStatus(null);
  const signal = intent.signal === undefined ? {} : { signal: intent.signal };
  if (route.kind === "app") {
    const outcome = await route.command.run(signal);
    if (outcome.message !== undefined) showStatus(outcome.message);
    return;
  }
  const request = runMode === undefined ? null : modeChangeFromCommand(route.command);
  if (runMode !== undefined && request !== null) {
    const outcome = await runMode(request, signal);
    showStatus(
      outcome.outcome === "unknown"
        ? describeOutputs(outcome.outputs, route.command)
        : modeOutcomeText(outcome),
    );
    return;
  }
  if (provider === null) {
    throw new AppFailure({
      code: "unavailable",
      message: "Slash commands are unavailable in this omp session.",
      retryable: false,
    });
  }
  // omp ends an idle command with an "aborted" marker after printing its own words, so the marker is not a
  // failure here. The person's own cancellation arrives as a thrown AppFailure from the call itself.
  const result = await provider.execute(route.command, signal);
  showStatus(describeCommandResult(result, route.command));
}
