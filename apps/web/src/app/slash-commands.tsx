import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type CommandRunResult,
  type ModeChangeRequest,
  type ModeChangeResult,
  modeChangeFromCommand,
  type PortCallOptions,
  type RpcSessionSend,
  type ThreadId,
} from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  commandOutputView,
  createSlashCommandProvider,
  guardedCommandName,
  guardedRoute,
  plainOutputText,
  type SlashAppCommand,
  type SlashCommandProvider,
  type SlashRoute,
} from "@/modules/D2/slash";
import type { SessionLifecycleController } from "@/modules/D5/lifecycle";
import { modeOutcomeText } from "@/modules/D7/modes";
import type { GoalRpcArgs, GoalRpcResult } from "@/modules/D8/contract";
import { createMcpProtocolCatalogs } from "@/modules/I1/protocol";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import { sessionTitle } from "@/modules/R1/ui";
import type { PromptIntent } from "@/modules/U2/contract";
import {
  type OverlayOpener,
  openChatDeleteConfirm,
} from "@/modules/U4/dialogs/confirm-chat-delete";
import { openSpendResetConfirm } from "@/modules/U4/dialogs/confirm-spend-reset";
import type { AgentHubOpenResult } from "./agents/agent-hub-shortcut";
import type { CommandReport } from "./command-report/command-report";
import { describeGoalResult, parseGoalCommand } from "./goal-command";

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
 * `/goal`: omp's goal mode is a terminal command (`handleTui`), but its RPC runs the same lifecycle as the `goal`
 * command, so the app sends it there and says what omp now has. Bare `/goal` shows the goal; text after it sets one;
 * `pause`, `resume` and `drop` act on it (goal-command.ts).
 */
export function goalSlashCommand({
  sendGoal,
}: {
  readonly sendGoal: (args: GoalRpcArgs) => Promise<GoalRpcResult>;
}): SlashAppCommand {
  return {
    name: "goal",
    description: "Show, set, pause, resume or drop the goal",
    takesArguments: true,
    run: async ({ args }) => {
      const command = parseGoalCommand(args ?? "");
      if (command.kind === "refused") {
        throw new AppFailure({ code: "unavailable", message: command.reason, retryable: false });
      }
      const result = await sendGoal(command.args);
      return { message: describeGoalResult(command.args.op, result) };
    },
  };
}

/**
 * `/hub`: omp's Agent Hub is a terminal panel, so the app opens its own, the one Alt+A and the palette open. A chat
 * with no agent yet has nothing to show, and the header says so.
 */
export function agentHubSlashCommand({
  openAgentHub,
}: {
  readonly openAgentHub: () => Promise<AgentHubOpenResult>;
}): SlashAppCommand {
  return {
    name: "hub",
    description: "Open the Agent Hub",
    run: async () => {
      const result = await openAgentHub();
      if (result === "opened") return {};
      if (result === "empty") return { message: "No agents to show yet." };
      throw new AppFailure({
        code: "unavailable",
        message: "The Agent Hub cannot open for this chat right now.",
        retryable: true,
      });
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

/** The part of the chat's command gateway a guarded form uses: running one omp command. */
interface CommandRunGateway {
  readonly run: (
    args: { readonly threadId: ThreadId; readonly command: string },
    options?: PortCallOptions,
  ) => Promise<CommandRunResult>;
}

/**
 * A guarded form that omp runs at once: `/session delete` or `/usage reset <target>`. The app asks first, the way its own
 * controls do. Confirm sends the command to omp once, through the chat's gateway, and shows omp's words; Cancel sends
 * nothing. `args` is the text after the words, for a command that takes arguments.
 */
export function askFirstSlashCommand({
  name,
  description,
  takesArguments,
  confirm,
  gateway,
  threadId,
  showReport,
}: {
  readonly name: string;
  readonly description: string;
  readonly takesArguments?: true;
  /** Asks the person before omp runs anything. Resolves true only for the button that runs it. */
  readonly confirm: (args: string) => Promise<boolean>;
  readonly gateway: CommandRunGateway;
  readonly threadId: ThreadId;
  /** Shows omp's words for a reply with several lines, in the command output panel. */
  readonly showReport: (report: CommandReport) => void;
}): SlashAppCommand {
  return {
    name,
    description,
    unlisted: true,
    ...(takesArguments === undefined ? {} : { takesArguments }),
    run: async ({ signal, args = "" }) => {
      if (!(await confirm(args))) return {};
      const command = args === "" ? `/${name}` : `/${name} ${args}`;
      const result = await gateway.run(
        { threadId, command },
        signal === undefined ? {} : { signal },
      );
      const note = commandNote(
        result.outputs.map((output) => output.text),
        command,
        showReport,
      );
      return note === undefined ? {} : { message: note };
    },
  };
}

/**
 * The name the sidebar shows for a chat, which its own delete question uses. Until the sidebar's list holds the chat, the
 * header's title stands in for it.
 */
function sidebarChatName(
  catalog: SessionCatalogModel | null,
  threadId: ThreadId,
  fallback: string,
): string {
  const session = catalog?.getSnapshot().sessions.find((item) => item.id === threadId);
  return session === undefined ? fallback : sessionTitle(session);
}

/**
 * The two guarded forms that run an omp command at once. `/session delete` asks with the chat's own delete question,
 * naming the chat the way the sidebar does; `/usage reset <target>` names the account and says that one reset is spent.
 */
export function askFirstSlashCommands({
  catalog,
  fallbackTitle,
  overlay,
  gateway,
  threadId,
  showReport,
}: {
  readonly catalog: SessionCatalogModel | null;
  /** The header's title for the chat, used until the sidebar's list holds the chat. */
  readonly fallbackTitle: string;
  readonly overlay: OverlayOpener;
  readonly gateway: CommandRunGateway;
  readonly threadId: ThreadId;
  /** Shows omp's words for a reply with several lines, in the command output panel. */
  readonly showReport: (report: CommandReport) => void;
}): readonly SlashAppCommand[] {
  return [
    askFirstSlashCommand({
      name: "session delete",
      description: "Delete this chat, after you confirm",
      confirm: () =>
        openChatDeleteConfirm(overlay, sidebarChatName(catalog, threadId, fallbackTitle)),
      gateway,
      threadId,
      showReport,
    }),
    askFirstSlashCommand({
      name: "usage reset",
      description: "Spend a saved rate-limit reset, after you confirm",
      takesArguments: true,
      confirm: (target) => openSpendResetConfirm(overlay, describeResetTarget(target)),
      gateway,
      threadId,
      showReport,
    }),
  ];
}

/**
 * The account a typed `/usage reset` target names, in the words the confirmation uses: `codex/active` is "Codex, the
 * active account" and `claude/2` is "Claude account 2". A target that does not read that way is shown as typed, and omp
 * then says what it does with it.
 */
export function describeResetTarget(target: string): string {
  const text = target.trim();
  const slash = text.indexOf("/");
  const provider = slash > 0 ? resetProviderName(text.slice(0, slash)) : undefined;
  const account = text
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  if (provider !== undefined && account === "active") return `${provider}, the active account`;
  if (provider !== undefined && /^\d+$/u.test(account)) return `${provider} account ${account}`;
  return `the account "${text}"`;
}

/** The provider a typed reset target names, in omp's words for it (helpers/reset-usage.ts:28-39), or undefined. */
function resetProviderName(provider: string): string | undefined {
  switch (provider.trim().toLowerCase()) {
    case "anthropic":
    case "claude":
      return "Claude";
    case "openai-codex":
    case "codex":
      return "Codex";
    default:
      return undefined;
  }
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
 * The note the header shows for a command omp finished: omp's words as one line, or none when they have several lines.
 * Those go to the command output panel instead, which stays until the person closes it (`commandOutputView`).
 */
function commandNote(
  texts: readonly string[],
  command: string,
  showReport: (report: CommandReport) => void,
): string | undefined {
  const view = commandOutputView(texts, command);
  if (view.kind === "report") {
    showReport({ command, text: view.text });
    return undefined;
  }
  return view.text;
}

/**
 * Runs a routed command. The four mode commands run through the typed gateway, and their status says what omp did in
 * plain words; omp's own words show only for a reply the app does not recognise. Any other finished omp command shows
 * omp's words: several lines go to the command output panel, which stays until the person closes it, and one line
 * goes to the header. A command that fails throws its message, and the composer shows it and keeps the typed text,
 * as it does for any send.
 */
export async function runSlashRoute({
  route,
  intent,
  provider,
  showStatus,
  showReport,
  runMode,
}: {
  readonly route: SlashRoute;
  readonly intent: PromptIntent;
  readonly provider: SlashCommandProvider | null;
  readonly showStatus: (text: string | null) => void;
  /** Shows omp's words for a command that printed several lines, in the command output panel. */
  readonly showReport: (report: CommandReport) => void;
  /** The typed gateway for the four mode commands; without it they run as any other command. */
  readonly runMode?: (
    request: ModeChangeRequest,
    options: PortCallOptions,
  ) => Promise<ModeChangeResult>;
}): Promise<void> {
  showStatus(null);
  const signal = intent.signal === undefined ? {} : { signal: intent.signal };
  const showOutput = (texts: readonly string[], command: string) => {
    const note = commandNote(texts, command, showReport);
    if (note !== undefined) showStatus(note);
  };
  if (route.kind === "app") {
    const outcome = await route.command.run(
      route.args === undefined ? signal : { ...signal, args: route.args },
    );
    if (outcome.message !== undefined) showStatus(outcome.message);
    return;
  }
  const request = runMode === undefined ? null : modeChangeFromCommand(route.command);
  if (runMode !== undefined && request !== null) {
    const outcome = await runMode(request, signal);
    if (outcome.outcome === "unknown") showOutput(outcome.outputs, route.command);
    else showStatus(modeOutcomeText(outcome));
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
  showOutput(
    result.outputs.map((output) => output.text),
    route.command,
  );
}
