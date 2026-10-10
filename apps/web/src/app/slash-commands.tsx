import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type RpcSessionSend,
  type ThreadId,
} from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSlashCommandProvider,
  describeCommandResult,
  guardedCommandName,
  guardedRefusal,
  guardedRoute,
  plainOutputText,
  type SlashAppCommand,
  type SlashCommandProvider,
  type SlashRoute,
} from "@/modules/D2/slash";
import type { SessionLifecycleController } from "@/modules/D5/lifecycle";
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
 * `/share`: omp's own share uploads the whole chat with no question asked, so the app answers every form of it itself
 * (`guardedRoute`). Until the share dialog (D4.4) is mounted, the answer is this plain refusal, and nothing is uploaded.
 */
export function shareSlashCommand(): SlashAppCommand {
  return {
    name: "share",
    description: "Share this chat (not available yet)",
    run: () =>
      Promise.reject(
        new AppFailure({
          code: "unavailable",
          message: "Sharing this chat isn't available yet. Nothing was uploaded.",
          retryable: false,
        }),
      ),
  };
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
    if (name !== null) return Promise.reject(guardedRefusal(name));
    return send(args, options);
  };
}

/**
 * Runs a routed command. A finished omp command shows omp's words in the header. A command that fails
 * throws its message, and the composer shows it and keeps the typed text, as it does for any send.
 */
export async function runSlashRoute({
  route,
  intent,
  provider,
  showStatus,
}: {
  readonly route: SlashRoute;
  readonly intent: PromptIntent;
  readonly provider: SlashCommandProvider | null;
  readonly showStatus: (text: string | null) => void;
}): Promise<void> {
  showStatus(null);
  const signal = intent.signal === undefined ? {} : { signal: intent.signal };
  if (route.kind === "app") {
    const outcome = await route.command.run(signal);
    if (outcome.message !== undefined) showStatus(outcome.message);
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
