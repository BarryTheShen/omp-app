import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type CommandRunResult,
  type McpCommandActionArgs,
  type McpCommandActionResult,
  type ModeChangeRequest,
  type ModeChangeResult,
  modeChangeFromCommand,
  type PortCallOptions,
  type RpcSessionSend,
  type SessionDeleteCommandArgs,
  type SessionDeleteCommandResult,
  type SessionDeleteRefusal,
  type ThreadId,
} from "@omp-app/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  commandOutputView,
  createSlashCommandProvider,
  DESTRUCTIVE_FORMS,
  destructiveQuestion,
  guardedCommandName,
  guardedRoute,
  plainOutputText,
  routeSlashText,
  type SlashAppCommand,
  type SlashCommandProvider,
  type SlashRoute,
} from "@/modules/D2/slash";
import type { SessionLifecycleController } from "@/modules/D5/lifecycle";
import { modeOutcomeText } from "@/modules/D7/modes";
import type { GoalRpcArgs, GoalRpcResult } from "@/modules/D8/contract";
import type { ConversationTransitionPort } from "@/modules/P4/transitions";
import type { SessionCatalogModel } from "@/modules/R1/catalog/catalog";
import { sessionTitle } from "@/modules/R1/ui";
import type { PromptIntent } from "@/modules/U2/contract";
import {
  type OverlayOpener,
  openChatDeleteConfirm,
} from "@/modules/U4/dialogs/confirm-chat-delete";
import {
  type DestructiveConfirmText,
  openDestructiveCommandConfirm,
} from "@/modules/U4/dialogs/confirm-destructive-command";
import { openSpendResetConfirm } from "@/modules/U4/dialogs/confirm-spend-reset";
import { openWorktreeConfirm } from "@/modules/U4/dialogs/confirm-worktree";
import type { AgentHubOpenResult } from "./agents/agent-hub-shortcut";
import type { CommandReport } from "./command-report/command-report";
import { describeGoalResult, parseGoalCommand } from "./goal-command";
import type { NoSwitchNote } from "./rewind/no-switch-notice";

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
    const next = createSlashCommandProvider({
      client,
      threadId,
      capabilities: getCapabilities,
      appCommands: getAppCommands,
    });
    setProvider(next);
    return () => {
      setProvider(null);
      next.dispose();
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
 * Starts a new chat the way the command palette's New chat does, and opens it: "opened" once the new chat is open, or
 * "cancelled" when the person or the lifecycle stopped it. A chat that cannot start throws the sentence the person sees.
 */
async function openNewChat({
  lifecycle,
  openThread,
}: {
  readonly lifecycle: SessionLifecycleController | null;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
}): Promise<"opened" | "cancelled"> {
  if (lifecycle === null) {
    throw new AppFailure({
      code: "unavailable",
      message: "Starting a new chat requires a selected workspace folder.",
      retryable: false,
    });
  }
  const outcome = await lifecycle.newSession();
  if (outcome.status === "cancelled") return "cancelled";
  if (outcome.status === "completed") {
    await openThread(outcome.value);
    return "opened";
  }
  throw new AppFailure(outcome.error);
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
      if ((await openNewChat({ lifecycle, openThread })) === "cancelled") return {};
      return { message: "Started a new chat." };
    },
  };
}

/** What `/clear` writes into the new chat: omp's terminal clears in place, so the app says what it did instead. */
export const CLEAR_STARTED_NOTE: NoSwitchNote = {
  source: "clear",
  dedupeKey: "clear:started",
  message:
    "This is a new chat. omp can only clear a chat in place in its terminal, so /clear started a new one here. Your previous chat is still in your list.",
};

/**
 * `/clear`: omp clears a chat's context in place in its terminal, and omp's RPC has no way to, so the app starts a new
 * chat in the same folder and says so in it. The old chat stays in the list. A turn that is still running is waited for, as
 * `/branch` and `/fork` wait: the old chat would keep running unseen.
 */
export function clearSlashCommand({
  lifecycle,
  openThread,
  isBusy,
  deliverNote,
  focusComposer,
}: {
  readonly lifecycle: SessionLifecycleController | null;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
  readonly isBusy: () => boolean;
  /** Writes a note into the chat on screen, once that chat has opened. */
  readonly deliverNote: (note: NoSwitchNote) => void;
  readonly focusComposer: () => void;
}): SlashAppCommand {
  return {
    name: "clear",
    description: "Start a new chat with an empty context. This chat stays in your list.",
    takesArguments: true,
    run: async ({ args }) => {
      if (args !== undefined) throw wordsRefusal(takesNothing("clear"));
      if (isBusy()) return { message: "Wait for this chat's turn to finish, then clear it." };
      if ((await openNewChat({ lifecycle, openThread })) === "cancelled") return {};
      deliverNote(CLEAR_STARTED_NOTE);
      focusComposer();
      return {};
    },
  };
}

/**
 * `/fresh`: the command palette's Refresh model connection action, so typing it asks the same confirmation before
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

/**
 * `/copy`: the app's own command, the conversation copy picker over this chat. It runs the same copy action the palette
 * command runs, so typed `/copy` and the palette give one result.
 */
export function copySlashCommand({ copy }: { readonly copy: () => unknown }): SlashAppCommand {
  return {
    name: "copy",
    description: "Copy from this chat",
    run: async () => {
      await copy();
      return {};
    },
  };
}

/**
 * `/mcp reload`: over RPC omp only refreshes its command list and reconnects no MCP server, so the app runs the typed
 * reload (A1's `action`) and shows the message that says what it did, not omp's own words for it.
 */
export function mcpReloadSlashCommand({
  commands,
  threadId,
}: {
  readonly commands: {
    readonly action: (
      args: McpCommandActionArgs,
      options?: PortCallOptions,
    ) => Promise<McpCommandActionResult>;
  };
  readonly threadId: ThreadId;
}): SlashAppCommand {
  return {
    name: "mcp reload",
    description: "Refresh the command list omp offers",
    unlisted: true,
    run: async ({ signal }) => {
      const result = await commands.action(
        { threadId, operation: "reload", operationId: crypto.randomUUID() },
        signal === undefined ? {} : { signal },
      );
      return { message: result.message ?? "The command list was refreshed." };
    },
  };
}

/** The part of the chat's command gateway the guarded forms use: running one omp command, and the typed `/session delete`. */
interface CommandRunGateway {
  readonly run: (
    args: { readonly threadId: ThreadId; readonly command: string },
    options?: PortCallOptions,
  ) => Promise<CommandRunResult>;
  readonly sessionDelete: (
    args: SessionDeleteCommandArgs,
    options?: PortCallOptions,
  ) => Promise<SessionDeleteCommandResult>;
}

/**
 * A guarded form that omp runs at once, such as `/usage reset <target>`. The app asks first, the way its own controls do.
 * Confirm sends the command to omp once, through the chat's gateway, and shows omp's words; Cancel sends nothing. `args` is
 * the text after the words, for a command that takes arguments.
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
 * The header's plain sentence for a `/session delete` that deleted nothing, by its typed reason. The app writes these, so
 * the browser never reads omp's words.
 */
const SESSION_DELETE_NOTE: Record<SessionDeleteRefusal | "failed" | "unknown", string> = {
  running: "Wait for this chat's turn to finish, then delete it.",
  "open-elsewhere":
    "Another tab or window has this chat open. Close it there, then delete it again.",
  finishing: "omp is still finishing this chat. Try again in a moment.",
  "not-saved": "This chat is not saved yet, so there is nothing to delete.",
  failed: "The chat was not deleted. Try again.",
  unknown: "omp did not delete the chat.",
};

/** What `/session delete` and `/delete` need: the question, the gateway, the chat, and what follows a delete. */
interface SessionDeleteDeps {
  readonly confirm: () => Promise<boolean>;
  readonly gateway: CommandRunGateway;
  readonly threadId: ThreadId;
  readonly catalog: SessionCatalogModel | null;
  readonly lifecycle: SessionLifecycleController | null;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
}

/**
 * `/session delete`: asks with the chat's own delete question, naming the chat the way the sidebar does. Confirm sends the
 * command to omp once, through the typed gateway; Cancel sends nothing. Only a `deleted` outcome changes the view: the open
 * chat leaves first, a new chat taking its place as the sidebar's own Delete leaves it, and then the chat's row goes from
 * the list. The header shows no note for that: a note set on the chat that left would never show on the new chat. Every
 * other outcome changes nothing, and the header says why in a plain sentence (`SESSION_DELETE_NOTE`).
 */
export function sessionDeleteSlashCommand({
  confirm,
  gateway,
  threadId,
  catalog,
  lifecycle,
  openThread,
}: SessionDeleteDeps): SlashAppCommand {
  return {
    name: "session delete",
    description: "Delete this chat, after you confirm",
    unlisted: true,
    run: async ({ signal }) => {
      if (!(await confirm())) return {};
      const result = await gateway.sessionDelete(
        { threadId },
        signal === undefined ? {} : { signal },
      );
      if (result.outcome === "deleted") {
        try {
          await leaveDeletedChat(lifecycle, openThread);
        } finally {
          // The file is gone whatever the new chat did, so the row goes even when the new chat could not open.
          removeListedChat(catalog, threadId);
        }
        // The view has left the chat, so the header has no note to show: the sidebar's own Delete shows none either.
        return {};
      }
      const reason = result.outcome === "refused" ? result.reason : result.outcome;
      return { message: SESSION_DELETE_NOTE[reason] };
    },
  };
}

/**
 * `/delete`: the same question and the same flow as `/session delete`, under omp's own name for the action. omp's
 * terminal deletes the current session and starts a new one (builtin-lifecycle.ts:204) and takes no words, so words after
 * the name are refused here, and nothing is sent to omp or the model.
 */
export function deleteSlashCommand(deps: SessionDeleteDeps): SlashAppCommand {
  const session = sessionDeleteSlashCommand(deps);
  return {
    name: "delete",
    description: "Delete this chat, after you confirm",
    takesArguments: true,
    run: ({ signal, args }) => {
      if (args !== undefined) return Promise.reject(wordsRefusal(takesNothing("delete")));
      return session.run(signal === undefined ? {} : { signal });
    },
  };
}

/** The refusal a command that takes nothing gives when words follow its name: the text stays, and nothing is sent. */
function takesNothing(name: string): string {
  return `/${name} doesn't take anything after it, so nothing was sent. Type /${name} on its own.`;
}

/** The refusal as an app failure, so the composer keeps the typed text and shows the sentence. */
function wordsRefusal(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

/** The conversation-history panel `/tree` and `/branch` open. It is offered only while omp has the tree and branch commands. */
export interface HistoryPanel {
  available(): boolean;
  open(): void;
}

/**
 * `/tree`: opens the conversation-history panel, where the messages are browsed. omp's terminal moves the current point of the
 * tree in place (selector-controller.ts:1504-1675); RPC cannot do that, so the panel offers Rewind and Fork instead.
 */
export function treeSlashCommand({ panel }: { readonly panel: HistoryPanel }): SlashAppCommand {
  return {
    name: "tree",
    description: "Browse this chat's messages, to rewind or fork from one",
    takesArguments: true,
    run: async ({ args }) => {
      if (args !== undefined) throw wordsRefusal(takesNothing("tree"));
      if (!panel.available()) {
        throw new AppFailure({
          code: "unavailable",
          message: "Browsing earlier messages isn't available with this version of omp.",
          retryable: false,
        });
      }
      panel.open();
      return {
        message: "Browse this chat's messages here. Rewinding opens a new chat and keeps this one.",
      };
    },
  };
}

/**
 * `/branch`, and its alias `/rewind`: opens the same panel, to rewind to one of the person's messages. omp's terminal rewinds
 * in place (selector-controller.ts:1407-1445); the panel's Rewind makes a new chat from before the message and keeps this one.
 * While a turn runs, the panel does not open: the header says to wait.
 */
export function branchSlashCommand({
  panel,
  isBusy,
}: {
  readonly panel: HistoryPanel;
  readonly isBusy: () => boolean;
}): SlashAppCommand {
  return {
    name: "branch",
    aliases: ["rewind"],
    description: "Rewind this chat to one of your messages. This chat is kept.",
    takesArguments: true,
    run: async ({ args }) => {
      if (args !== undefined) {
        throw wordsRefusal(
          "/branch and /rewind don't take anything after them, so nothing was sent. Type /branch on its own.",
        );
      }
      if (!panel.available()) {
        throw new AppFailure({
          code: "unavailable",
          message: "Rewinding isn't available with this version of omp.",
          retryable: false,
        });
      }
      if (isBusy()) return { message: "Wait for this chat's turn to finish, then rewind it." };
      panel.open();
      return {
        message:
          "Choose one of your messages to rewind to. Your files are not changed, and this chat is kept.",
      };
    },
  };
}

/** The question before `/restart` runs: the destructive frame, with omp's restart in its words. */
export function restartQuestion(turnRunning: boolean): DestructiveConfirmText {
  return {
    label: "Restart omp",
    title: "Restart omp for this chat?",
    description: turnRunning
      ? "A reply is still being written, and it will stop. omp then starts again on this chat's saved messages. Background work omp started for this chat may stop too."
      : "omp stops and starts again on this chat's saved messages. Background work omp started for this chat may stop too.",
    confirmLabel: "Restart omp",
  };
}

export interface RestartDeps {
  /** Asks the question; resolves true only when the person chooses Restart omp. */
  readonly confirm: (turnRunning: boolean) => Promise<boolean>;
  /** Restarts this chat's omp on its saved messages, as the banner's Restart omp button does. */
  readonly restart: () => Promise<void>;
  /** Whether a reply is still being written in this chat. */
  readonly isBusy: () => boolean;
}

/**
 * `/restart`: omp's own name for restarting omp on this chat (omp's builtin-lifecycle `restart`). It stops a reply that is
 * running, so it asks first, and Cancel sends nothing. Words after the name are refused, and nothing is sent to omp or the model.
 */
export function restartSlashCommand({ confirm, restart, isBusy }: RestartDeps): SlashAppCommand {
  return {
    name: "restart",
    description: "Restart omp on this chat, after you confirm",
    takesArguments: true,
    run: async ({ args }) => {
      if (args !== undefined) throw wordsRefusal(takesNothing("restart"));
      if (!(await confirm(isBusy()))) return {};
      try {
        await restart();
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw new AppFailure({
          code: "internal",
          message: "omp could not be restarted. Try again.",
          retryable: true,
        });
      }
      return { message: "omp restarted. This chat is where you left it." };
    },
  };
}

/** The note `/fork` writes into the copy it opens: the copy is open, and the original is still in the list. */
export const FORK_DONE_NOTE: NoSwitchNote = {
  source: "fork",
  dedupeKey: "fork:forked",
  message: "Forked. You are now in the copy of your chat. The original is still in your list.",
};

/**
 * `/fork`: forks the whole chat into a copy through the conversation transition port, then moves the view to the copy and
 * writes a note there. omp's terminal forks the session and moves onto the copy (command-controller.ts:1388-1432). With words
 * after it, the terminal opens a multiplexer pane or window (builtin-session.ts:618-647), which the app cannot do, so the words
 * are refused. A busy chat is refused with a header note that says to wait.
 */
export function forkSlashCommand({
  transitions,
  threadId,
  isBusy,
  deliverNote,
  focusComposer,
}: {
  readonly transitions: ConversationTransitionPort;
  readonly threadId: ThreadId;
  readonly isBusy: () => boolean;
  readonly deliverNote: (note: NoSwitchNote) => void;
  readonly focusComposer: () => void;
}): SlashAppCommand {
  return {
    name: "fork",
    description: "Fork this chat into a copy and open it. The original is kept.",
    takesArguments: true,
    run: async ({ args, signal }) => {
      if (args !== undefined) {
        throw wordsRefusal(
          "/fork on its own forks this chat here. Anything after it, such as pane or window, only works in omp's terminal, so nothing was sent.",
        );
      }
      if (isBusy()) return { message: "Wait for this chat's turn to finish, then fork it." };
      try {
        const result = await transitions.fork(
          signal instanceof AbortSignal ? { threadId, signal } : { threadId },
        );
        if (result.cancelled) {
          return {
            message:
              "omp did not fork this chat. If the chat is new, send a message first, then try again.",
          };
        }
        if (result.reloaded) {
          void deliverNote(FORK_DONE_NOTE);
          focusComposer();
        }
        return {};
      } catch (error) {
        if (error instanceof AppFailure && error.appError.code === "conflict") {
          return { message: "Wait for this chat's turn to finish, then fork it." };
        }
        if (error instanceof AppFailure && error.appError.code === "cancelled") return {};
        if (error instanceof AppFailure && error.appError.code === "unavailable") {
          throw new AppFailure({
            code: "unavailable",
            message: "Forking isn't available with this version of omp.",
            retryable: false,
          });
        }
        throw new AppFailure({
          code: "internal",
          message: "This chat could not be forked. Try again.",
          retryable: true,
        });
      }
    },
  };
}

/**
 * Opens a new chat in place of the deleted one: the lifecycle's new session, the same one the sidebar's own New chat
 * starts. A new session that cannot start is the failure the person sees.
 */
async function leaveDeletedChat(
  lifecycle: SessionLifecycleController | null,
  openThread: (threadId: ThreadId) => Promise<void>,
): Promise<void> {
  if (lifecycle === null) {
    throw new AppFailure({
      code: "unavailable",
      message: "Starting a new chat requires a selected workspace folder.",
      retryable: false,
    });
  }
  const outcome = await lifecycle.newSession();
  if (outcome.status === "completed") {
    await openThread(outcome.value);
    return;
  }
  if (outcome.status === "cancelled") return;
  throw new AppFailure(outcome.error);
}

/**
 * Drops the deleted chat's row from the folder's list. The catalog takes the change the server's `removed` event carries
 * for the sidebar's own Delete, so the row goes and no later read brings it back. A chat the list does not hold has no row.
 */
function removeListedChat(catalog: SessionCatalogModel | null, threadId: ThreadId): void {
  if (catalog === null) return;
  const session = catalog.getSnapshot().sessions.find((item) => item.id === threadId);
  if (session === undefined) return;
  void catalog.reconcile({
    kind: "removed",
    folder: session.cwd,
    sessionFile: session.sessionFile,
    id: threadId,
  });
}

/**
 * The guarded forms that run at once, each after its own question. `/session delete` and `/delete` ask with the chat's own
 * delete question, naming the chat the way the sidebar does, and change the view only once omp says it deleted the chat's
 * file; `/usage reset <target>` names the account and says that one reset is spent. Each form that deletes data
 * (`DESTRUCTIVE_FORMS`) names its target and says what omp deletes; Cancel sends nothing, and Confirm sends the command once.
 */
export function askFirstSlashCommands({
  catalog,
  fallbackTitle,
  overlay,
  gateway,
  threadId,
  lifecycle,
  openThread,
  showReport,
}: {
  readonly catalog: SessionCatalogModel | null;
  /** The header's title for the chat, used until the sidebar's list holds the chat. */
  readonly fallbackTitle: string;
  readonly overlay: OverlayOpener;
  readonly gateway: CommandRunGateway;
  readonly threadId: ThreadId;
  /** Opens the new chat that takes the deleted chat's place, as the sidebar's own Delete does. */
  readonly lifecycle: SessionLifecycleController | null;
  readonly openThread: (threadId: ThreadId) => Promise<void>;
  /** Shows omp's words for a reply with several lines, in the command output panel. */
  readonly showReport: (report: CommandReport) => void;
}): readonly SlashAppCommand[] {
  const sessionDelete: SessionDeleteDeps = {
    confirm: () =>
      openChatDeleteConfirm(overlay, sidebarChatName(catalog, threadId, fallbackTitle)),
    gateway,
    threadId,
    catalog,
    lifecycle,
    openThread,
  };
  return [
    sessionDeleteSlashCommand(sessionDelete),
    deleteSlashCommand(sessionDelete),
    askFirstSlashCommand({
      name: "usage reset",
      description: "Spend a saved rate-limit reset, after you confirm",
      takesArguments: true,
      confirm: (target) => openSpendResetConfirm(overlay, describeResetTarget(target)),
      gateway,
      threadId,
      showReport,
    }),
    ...["wt", "worktree"].map((name) =>
      askFirstSlashCommand({
        name,
        description: "Move this chat into a worktree, after you confirm",
        takesArguments: true,
        confirm: (branch) => openWorktreeConfirm(overlay, branch),
        gateway,
        threadId,
        showReport,
      }),
    ),
    ...DESTRUCTIVE_FORMS.map((form) =>
      askFirstSlashCommand({
        name: form,
        description: "Asks first, then runs it in omp",
        takesArguments: true,
        confirm: async (args) => {
          const question = destructiveQuestion(form, args);
          // A form with no target, or a scope omp refuses, deletes nothing: omp only prints its usage for it.
          return question === null ? true : openDestructiveCommandConfirm(overlay, question);
        },
        gateway,
        threadId,
        showReport,
      }),
    ),
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
  if (hasAttachments || (intent.images?.length ?? 0) > 0) return Promise.resolve(null);
  const appRoute = routeSlashText(intent.text, [], appCommands);
  if (provider === null) return Promise.resolve(appRoute?.kind === "app" ? appRoute : null);
  if (appRoute?.kind === "app") return Promise.resolve(appRoute);
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
