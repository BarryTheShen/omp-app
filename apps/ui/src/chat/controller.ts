import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  AppFailure,
  type ChatSessionClient,
  type ChatSessionEvent,
  ChatSessionPort,
  type EntryId,
  type FileSearchCandidate,
  FileSearchPort,
  type FolderPath,
  type SessionFilePath,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import {
  type AssignModelRoleParams,
  type ChatHostCommand,
  type ChatHostImage,
  type ChatHostMethod,
  type ChatHostMethodMap,
  type ClearModelRoleParams,
  type GoalParams,
  type HostDialogAnswer,
  isHostDialogRequest,
  type LoginProvider,
  type ModelHub,
  type PlanFile,
  type QueueName,
  type SubagentTranscript,
} from "@omp-app/contracts/chat-host";
import { AgentHubState } from "../agents/hub-state";
import { type BtwRecord, BtwStore, withBtwCommand } from "../btw/btw";
import { type Attention, AttentionTracker } from "../inbox/attention";
import { ModelHubToggle } from "../models/hub";
import { ChatDraft } from "./drafts";
import { type ChatModel, ChatStore, type PlanProposal, toChatModel } from "./store";
import type { ShellRun } from "./triggers";
import { cachedWindow, keepWindow } from "./windowCache";

/** The first window read from a session file: enough for the newest screens, small enough to parse at once. */
export const FIRST_WINDOW_BYTES = 512 * 1024;
const OLDER_WINDOW_BYTES = 1024 * 1024;

/** A chat's usage for the side panel: omp's session statistics (its `/session` numbers) and the last reply's speed. */
export interface ChatUsage {
  readonly stats: ChatHostMethodMap["get_session_stats"]["result"];
  /** Output tokens per second of the last reply; null when omp has none to tell. */
  readonly tokensPerSecond: number | null;
}

export type ChatTarget =
  | {
      readonly kind: "existing";
      readonly threadId: ThreadId;
      readonly sessionFile: SessionFilePath;
    }
  | { readonly kind: "new"; readonly folder: FolderPath };

/**
 * One open chat: its store, its chat host and its event stream. Opening paints the newest entries of the session file
 * before omp is up, then starts or joins the chat's host and follows its events, asking for streaming deltas.
 */
export class ChatController {
  readonly store = new ChatStore();
  /** omp's `/btw` side questions of the chat, and their sheet; omp's status lines about them show as toasts. */
  readonly btw = new BtwStore((text) => this.store.toast(text, "info"));
  /** Whether this pane's Models dialog (omp's Alt+M) is open. */
  readonly modelHubToggle = new ModelHubToggle();
  /** This pane's Agent Hub: closed, or open on a subagent or on the list alone. */
  readonly agentHub = new AgentHubState();
  /** Reads this chat's live events for what its runs settle with (the inbox's rows). */
  readonly #attention = new AttentionTracker();
  readonly #attentionListeners = new Set<(attention: Attention) => void>();
  #threadId: ThreadId | null;
  #sessionFile: SessionFilePath | null;
  #subscription: AppClientSubscription<ChatSessionEvent> | null = null;
  #loadingOlder = false;
  #draft: ChatDraft;
  #disposed = false;
  /**
   * Where the transcript's branch ends after an edit rewound the chat: an entry, or null for the chat's very start.
   * Undefined while the branch ends at the file's last entry, as it does again once omp writes the next turn.
   */
  #leaf: string | null | undefined = undefined;
  /** Whether the file's window has been read: what this browser kept is shown only until then. */
  #windowRead = false;
  /**
   * Whether this pane's open took a view of the chat: the server counts it until it is closed, and stops omp once nobody
   * views the chat and its idle time has passed.
   */
  #viewTaken = false;
  /** Events before the subscription is acknowledged are the server's replay: history, not new requests. */
  #live = false;
  #commands: Promise<readonly ChatHostCommand[]> | null = null;
  /** The roles Ctrl+P walks, in omp's `cycleOrder`, as last read; empty until read. */
  #roleOrder: readonly string[] = [];
  /** The server answers no role methods (it predates them): Ctrl+P says so instead of failing. */
  #noRoles = false;
  readonly #stopResync: () => void;
  private readonly client: AppClient;
  private readonly target: ChatTarget;
  /** The folder the chat works in: `@` mentions search it, and a new chat's welcome names it. */
  readonly folder: FolderPath;

  /** `paneChat` names the pane's chat: a new chat's unsent text is kept under it until the chat has an id. */
  constructor(client: AppClient, target: ChatTarget, folder: FolderPath, paneChat: string) {
    this.client = client;
    this.target = target;
    this.folder = folder;
    this.#threadId = target.kind === "existing" ? target.threadId : null;
    this.#sessionFile = target.kind === "existing" ? target.sessionFile : null;
    this.#draft =
      target.kind === "existing"
        ? new ChatDraft(client, target.threadId)
        : ChatDraft.forNewChat(client, paneChat);
    // A gap in the event stream: the file holds what was missed, and omp's state says whether a turn started or ended.
    this.#stopResync = client.onResync((event) => {
      if (event.stream !== this.#subscription?.stream) return;
      this.#refreshWindow();
      this.#refreshState().catch(() => undefined);
    });
  }

  /** The chat's unsent text. A new chat's is kept from the start, under its pane, and under its id once it has one. */
  get draft(): ChatDraft {
    return this.#draft;
  }

  get threadId(): ThreadId | null {
    return this.#threadId;
  }

  /** The chat's session file once omp named it; a new chat's is named when it opens, and written with omp's first reply. */
  get sessionFile(): SessionFilePath | null {
    return this.#sessionFile;
  }

  /** A chat started here from nothing (New chat), as against a saved one opened again. */
  get isNew(): boolean {
    return this.target.kind === "new";
  }

  /** What this chat's live runs settle with that may need you: a turn done or failed, omp gone. */
  onAttention(listener: (attention: Attention) => void): () => void {
    this.#attentionListeners.add(listener);
    return () => {
      this.#attentionListeners.delete(listener);
    };
  }

  /** Opens the chat for this pane. A failure is said in the transcript; a pane that went away meanwhile says nothing. */
  async open(): Promise<void> {
    try {
      await this.#open();
    } catch (failure) {
      if (this.#disposed) return;
      this.store.addNotice(
        `Could not open this chat: ${failure instanceof Error ? failure.message : String(failure)}`,
        "error",
      );
      this.store.setPhase("ended");
    }
  }

  async #open(): Promise<void> {
    if (this.#sessionFile !== null) {
      // A chat opened before shows what this browser kept of it at once; the file's window replaces it when it comes.
      const fromFile = this.#reloadWindow();
      const threadId = this.#threadId;
      const kept = threadId === null ? undefined : await cachedWindow(threadId);
      if (kept !== undefined && !this.#windowRead && !this.#disposed)
        this.store.setWindow(kept.entries, kept.hasOlder);
      await fromFile;
    }
    const chat = this.client.port(ChatSessionPort);
    const opened = await chat.open(
      this.target.kind === "existing"
        ? { threadId: this.target.threadId }
        : { folderPath: this.target.folder, start: "new" },
    );
    this.#viewTaken = true;
    if (this.#disposed) {
      await this.#releaseView(opened.threadId);
      return;
    }
    this.#threadId = opened.threadId;
    if (this.target.kind === "new") this.#draft.keepFor(opened.threadId);
    this.#sessionFile = opened.sessionFile;
    this.#subscription = await this.client.subscribe(ChatSessionPort, "event", {
      scope: opened.threadId,
      afterSeq: 0,
      onEvent: (payload) => this.#onEvent(payload),
    });
    if (this.#disposed) {
      await this.#subscription.unsubscribe();
      return;
    }
    this.#live = true;
    await chat.setEventOptions({ threadId: opened.threadId, messageUpdates: "delta" });
    // omp's ask tool then sends all its questions in one request, with their checkboxes and typed answers; without
    // it, omp asks each question as a plain choice, which still works.
    await this.#request("set_ask_dialog", { enabled: true }).catch(() => undefined);
    await this.#refreshState();
    const open = await chat.openRequests({ threadId: opened.threadId });
    if (this.#disposed) return;
    this.store.restoreRequests(open.map((item) => item.request).filter(isHostDialogRequest));
    this.store.setPhase("live");
    const unshown = (what: string) => (failure: unknown) => {
      if (this.#disposed) return;
      this.store.addNotice(
        `${what}: ${failure instanceof Error ? failure.message : String(failure)}`,
        "warning",
      );
    };
    this.#followAgents(opened.threadId).catch(unshown("This chat's subagents are not shown"));
    this.#readModes().catch(unshown("Plan mode and the goal are not shown"));
    this.#refreshRole().catch(() => undefined);
  }

  /** omp's plan mode and the chat's goal, as they are when the chat opens. */
  async #readModes(): Promise<void> {
    const switches = this.#planSwitches;
    const [plan, goal] = await Promise.all([
      this.#request("get_plan_mode", {}),
      this.#request("goal", { op: "get" }),
    ]);
    if (this.#disposed) return;
    if (switches === this.#planSwitches) this.store.setPlanMode(plan);
    this.store.setGoal(goal.goal);
  }

  /** Plan mode switches so far: an answer about plan mode counts only while no later switch is on its way. */
  #planSwitches = 0;
  /**
   * The latest plan mode switch until omp answers it. omp answers switches in order but starts a prompt as soon as it
   * reads one, so a message waits for this: it runs in the mode the chip shows.
   */
  #planSwitch: Promise<unknown> = Promise.resolve();

  /** Reads omp's plan mode again; a switch made while the read was on its way decides instead. */
  async #readPlanMode(): Promise<void> {
    const switches = this.#planSwitches;
    const status = await this.#request("get_plan_mode", {});
    if (!this.#disposed && switches === this.#planSwitches) this.store.setPlanMode(status);
  }

  /** omp's roster of this chat's subagents, kept current by its lifecycle and progress events. */
  async #followAgents(threadId: ThreadId): Promise<void> {
    await this.client
      .port(ChatSessionPort)
      .setSubagentSubscription({ threadId, level: "progress" });
    const { subagents } = await this.#request("get_subagents", {});
    if (!this.#disposed) this.store.setAgents(subagents);
  }

  /**
   * Sends a message: a new prompt, or while omp works, a steer (`followUp` queues it behind the turn). A prompt omp
   * refuses as busy (a turn this page did not see start, as when the chat was opened in the middle of one) is sent
   * again the same way.
   */
  async send(
    text: string,
    mode: "auto" | "followUp" = "auto",
    images: readonly ChatHostImage[] = [],
  ): Promise<void> {
    await this.#planSwitch;
    const message = { text, ...(images.length > 0 ? { images: [...images] } : {}) };
    const behind = { streamingBehavior: mode === "followUp" ? "followUp" : "steer" } as const;
    if (this.store.getSnapshot().working) {
      await this.#request("prompt", { ...message, ...behind });
      return;
    }
    try {
      await this.#request("prompt", message);
    } catch (failure) {
      if (!(failure instanceof AppFailure && failure.appError.code === "agent_busy")) throw failure;
      this.store.markWorking();
      await this.#request("prompt", { ...message, ...behind });
    }
  }

  /**
   * Edit: rewinds the chat to just before one of your messages, as omp's tree does, and returns the message's text and
   * images for the box; the transcript shows the chat up to that point. Sending starts a new branch there; the old one
   * stays in the session.
   */
  async rewind(
    entryId: string,
  ): Promise<{ readonly text: string; readonly images: readonly ChatHostImage[] } | null> {
    const result = await this.#request("navigate_tree", { entryId });
    if (result.cancelled) return null;
    this.#leaf = result.leafId;
    await this.#reloadWindow();
    return { text: result.editorText ?? "", images: result.editorImages ?? [] };
  }

  /** Stops the reply as omp's Escape does: every queued message comes back, in order, for the message box. */
  async stop(): Promise<readonly string[]> {
    if (this.#threadId === null) return [];
    const restored = await this.#request("abort_and_restore_queue", {});
    return [...restored.steering, ...restored.followUp].map((message) => message.text);
  }

  /** Takes a queued message back out of its queue; null when omp already delivered it. */
  async takeQueued(message: string, queue: QueueName): Promise<string | null> {
    const result = await this.#request("remove_queued_message", { message, queue });
    return result.removed ? result.text : null;
  }

  async models(): Promise<readonly ChatModel[]> {
    const { models } = await this.#request("get_available_models", {});
    return models.map(toChatModel);
  }

  /** omp's sign-in providers, and whether each has a sign-in stored. */
  async loginProviders(): Promise<readonly LoginProvider[]> {
    return (await this.#request("get_login_providers", {})).providers;
  }

  /**
   * Signs in to a provider through this chat's omp. omp sends the page to open (the store's `signIn`) and may ask for
   * a code as one of its questions; this ends when the sign-in does.
   */
  async login(providerId: string): Promise<void> {
    try {
      await this.#request("login", { providerId });
    } finally {
      this.store.clearSignIn();
    }
  }

  async setModel(model: ChatModel): Promise<void> {
    const chosen = await this.#request("set_model", {
      provider: model.provider,
      modelId: model.id,
    });
    this.store.setModel(toChatModel(chosen));
  }

  /** The next thinking level omp offers for the model. */
  async cycleThinking(): Promise<void> {
    const result = await this.#request("cycle_thinking_level", {});
    if (result !== null) this.store.setThinkingLevel(result.level);
  }

  /**
   * Switches the chat to the next or previous role's model, as omp's Ctrl+P and Shift+Ctrl+P do (only this chat; the
   * settings stay), and shows the roles in their order for a moment, the one switched to marked.
   */
  async cycleRole(direction: "forward" | "backward"): Promise<void> {
    if (this.#noRoles) {
      this.store.toast(
        "This app server cannot switch role models yet; it needs an update.",
        "info",
      );
      return;
    }
    const switched = await this.#request("cycle_role_models", { direction });
    if (switched === null) {
      // omp's own words for a cycle with one role, or none, that has a model.
      this.store.toast("Only one role model available", "info");
      return;
    }
    this.store.setRole(switched.role);
    if (this.#roleOrder.length > 0) this.store.showRoleTrack(this.#roleOrder, switched.role);
  }

  /** The live model's role and the roles' order (`get_role_models`); a server that predates them gives none. */
  async #refreshRole(): Promise<void> {
    try {
      const roles = await this.#request("get_role_models", {});
      if (this.#disposed) return;
      this.#roleOrder = roles.order;
      this.store.setRole(roles.current);
    } catch (failure) {
      if (!(failure instanceof AppFailure && failure.appError.code === "invalid_args"))
        throw failure;
      this.#noRoles = true;
    }
  }

  /** omp's model hub for this chat (Alt+M): its roles with the model each resolves to, and the models a role takes. */
  async modelHub(): Promise<ModelHub> {
    try {
      return await this.#request("get_model_hub", {});
    } catch (failure) {
      throw olderServer(failure, "change model roles");
    }
  }

  /**
   * Gives a role a model, as omp's hub does: `default` also switches this chat, other roles only change their setting.
   * `applied` is false where omp did not apply it; `status` is the line omp shows.
   */
  async assignRole(
    params: AssignModelRoleParams,
  ): Promise<{ readonly applied: boolean; readonly status: string }> {
    try {
      return await this.#request("assign_model_role", params);
    } catch (failure) {
      throw olderServer(failure, "change model roles");
    }
  }

  /** Clears a role's setting, as omp's hub does; the lines omp shows for it (a second when this chat switched). */
  async clearRole(params: ClearModelRoleParams): Promise<readonly string[]> {
    try {
      const { status, switchedTo } = await this.#request("clear_model_role", params);
      return switchedTo === null ? [status] : [status, `Default model: ${switchedTo}`];
    } catch (failure) {
      throw olderServer(failure, "change model roles");
    }
  }

  /** Answers a dialog omp waits on (an approval, a question). */
  async answer(id: string, answer: HostDialogAnswer): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null) throw new Error("The chat is not open yet.");
    await this.client.port(ChatSessionPort).answer({ threadId, id, answer });
    this.store.removeRequest(id);
  }

  /** This chat's usage: omp's session statistics and the last reply's speed. */
  async usage(): Promise<ChatUsage> {
    const [stats, state] = await Promise.all([
      this.#request("get_session_stats", {}),
      this.#request("get_state", {}),
    ]);
    return { stats, tokensPerSecond: state.tokensPerSecond };
  }

  /** omp's `/` commands for this chat, read once and then kept current by omp's `available_commands`. */
  commands(): Promise<readonly ChatHostCommand[]> {
    if (this.#commands === null) {
      const read = this.#request("get_available_commands", {}).then((result) =>
        withBtwCommand(result.commands),
      );
      // A failed read is tried again next time.
      read.catch(() => {
        if (this.#commands === read) this.#commands = null;
      });
      this.#commands = read;
    }
    return this.#commands;
  }

  /**
   * Asks a side question about the chat (or a follow-up in topic `recordId`), as omp's `/btw` does: answered beside the
   * chat, also while omp works, and kept out of it. Resolves once omp saved it as running; its answer streams into
   * `btw`.
   */
  async askBtw(question: string, recordId?: string): Promise<BtwRecord> {
    try {
      const { record } = await this.#request("btw", {
        question,
        ...(recordId === undefined ? {} : { recordId }),
      });
      this.btw.asked(record);
      return record;
    } catch (failure) {
      throw olderServer(failure, "answer side questions");
    }
  }

  /** Stops the side question of topic `recordId` while it answers; false when it was not answering. */
  async cancelBtw(recordId: string): Promise<boolean> {
    return (await this.#request("btw_cancel", { recordId })).cancelled;
  }

  /** Reads the chat's side questions again, as omp keeps them (omp's terminal may have asked some). */
  async loadBtw(): Promise<void> {
    try {
      const { records } = await this.#request("get_btw_history", {});
      if (!this.#disposed) this.btw.setRecords(records);
    } catch (failure) {
      throw olderServer(failure, "answer side questions");
    }
  }

  /** Files and folders of the chat's folder that match an `@` mention. */
  async searchFiles(query: string): Promise<readonly FileSearchCandidate[]> {
    const found = await this.client
      .port(FileSearchPort)
      .search({ folder: this.folder, query, limit: 30 });
    return found.results;
  }

  /** A `!` or `$` run: omp runs it and records it in the chat; its start and end, with omp's result, come as events. */
  async runShell(run: ShellRun): Promise<void> {
    this.store.expectShell(run.input, run.excludeFromContext);
    const excluded = run.excludeFromContext ? { excludeFromContext: true } : {};
    if (run.method === "bash") await this.#request("bash", { command: run.input, ...excluded });
    else await this.#request("python", { code: run.input, ...excluded });
  }

  /** Stops the running `!` command; omp records it as cancelled. */
  async stopShell(): Promise<void> {
    await this.#request("abort_bash", {});
  }

  /** A subagent's transcript: its file's whole lines from `fromByte` on, for the Agent Hub. */
  subagentTranscript(subagentId: string, fromByte: number): Promise<SubagentTranscript> {
    return this.#request("get_subagent_messages", { subagentId, fromByte });
  }

  /** omp's hard kill of a running subagent; false when it was no longer running. */
  async cancelSubagent(subagentId: string): Promise<boolean> {
    return (await this.#request("cancel_subagent", { subagentId })).cancelled;
  }

  /** Sends a message to a running subagent; resolves once omp has taken it. */
  async steerSubagent(subagentId: string, message: string): Promise<void> {
    await this.#request("steer_subagent", { subagentId, message });
  }

  /**
   * Turns omp's plan mode on or off. The chip shows it at once: omp can take seconds to answer the first switch after a
   * chat opens. omp's answer to the latest switch decides; a refusal (work running, a goal active) shows omp's state
   * again, and the caller shows omp's sentence.
   */
  async setPlanMode(enabled: boolean): Promise<void> {
    const switches = ++this.#planSwitches;
    const shown = this.store.getSnapshot().planMode;
    if (shown !== null) this.store.setPlanMode({ ...shown, enabled });
    try {
      const request = this.#request("set_plan_mode", { enabled });
      this.#planSwitch = request.catch(() => undefined);
      const status = await request;
      if (!this.#disposed && switches === this.#planSwitches) this.store.setPlanMode(status);
    } catch (failure) {
      if (switches === this.#planSwitches) this.#readPlanMode().catch(() => undefined);
      throw failure;
    }
  }

  /** A plan file's text, for the review. */
  readPlan(planFilePath: string): Promise<PlanFile> {
    return this.#request("get_plan", { planFilePath });
  }

  /** omp's "Approve and keep context": plan mode ends, and the run on the plan starts in this chat. */
  async approvePlan(proposal: PlanProposal): Promise<void> {
    await this.#request("approve_plan", {
      planFilePath: proposal.planFilePath,
      title: proposal.title,
    });
    this.store.clearProposal();
    await this.#readPlanMode();
  }

  /** omp's goal mode: create (with its objective, and a token budget if given), pause, resume or drop the chat's goal. */
  async goal(
    op: Exclude<GoalParams["op"], "get">,
    objective?: string,
    tokenBudget?: number,
  ): Promise<void> {
    const answer = await this.#request("goal", {
      op,
      ...(objective === undefined ? {} : { objective }),
      ...(tokenBudget === undefined ? {} : { token_budget: tokenBudget }),
    });
    this.store.setGoal(answer.goal);
  }

  /** Reads the next older window of the session file into the transcript. */
  async loadOlder(): Promise<void> {
    const sessionFile = this.#sessionFile;
    const before = this.store.oldestId;
    if (
      sessionFile === null ||
      before === null ||
      this.#loadingOlder ||
      !this.store.getSnapshot().hasOlder
    )
      return;
    this.#loadingOlder = true;
    try {
      const window = await this.client.port(SessionFileStore).readEntryWindow({
        sessionFile,
        before: before as EntryId,
        byteBudget: OLDER_WINDOW_BYTES,
      });
      this.store.prependWindow(window.entries as unknown as SessionEntry[], window.hasOlder);
    } finally {
      this.#loadingOlder = false;
    }
  }

  #request<M extends ChatHostMethod>(
    method: M,
    params: ChatHostMethodMap[M]["params"],
  ): Promise<ChatHostMethodMap[M]["result"]> {
    const threadId = this.#threadId;
    if (threadId === null) return Promise.reject(new Error("The chat is not open yet."));
    // The port's generic client types `request` as unknown; `ChatSessionClient` types it by method.
    const chat = this.client.port(ChatSessionPort) as ChatSessionClient;
    return chat.request({ threadId, method, params });
  }

  async #refreshState(): Promise<void> {
    const asked = this.store.activityMark;
    const state = await this.#request("get_state", {});
    if (!this.#disposed) this.store.setState(state, asked);
  }

  #onEvent(payload: ChatSessionEvent): void {
    if (payload.kind === "moved") {
      this.#threadId = payload.threadId;
      this.#sessionFile = payload.sessionFile;
      if (this.target.kind === "new") this.#draft.keepFor(payload.threadId);
      this.btw.reset();
    }
    // A side question's answer redraws its sheet only, not the chat.
    if (payload.kind === "event" && this.btw.apply(payload.event)) return;
    this.store.apply(payload);
    // The server's replay of the chat's history is not news.
    if (this.#live) {
      const attention = this.#attention.take(payload);
      if (attention !== null)
        for (const listener of [...this.#attentionListeners]) listener(attention);
    }
    if (payload.kind === "host_request") {
      if (this.#live && isHostDialogRequest(payload.request))
        this.store.addRequest(payload.request);
      return;
    }
    if (payload.kind !== "event") return;
    // A new turn is written on from the branch's end, which makes it the file's last entry again.
    if (payload.event.type === "agent_start") this.#leaf = undefined;
    // A finished turn is read back from the file, so every entry shows with omp's own id.
    if (payload.event.type === "agent_end") this.#refreshWindow();
    if (payload.event.type === "model_changed") {
      void this.#refreshState();
      this.#refreshRole().catch(() => undefined);
    }
    // omp cleared finished todos on its own; the list it kept comes with the state.
    if (payload.event.type === "todo_auto_clear") this.#refreshState().catch(() => undefined);
    // Plan mode can change outside this pane (another tab, omp's own commands): read it again when omp settles.
    if (payload.event.type === "session_settled") this.#readPlanMode().catch(() => undefined);
    if (payload.event.type === "available_commands")
      this.#commands = Promise.resolve(withBtwCommand(payload.event.commands));
  }

  /** Reads the newest window again after omp wrote to the file; a new chat's file waits for omp's first reply. */
  #refreshWindow(): void {
    this.#reloadWindow().catch((error: unknown) => {
      if (error instanceof AppFailure && error.appError.code === "not_found") return;
      throw error;
    });
  }

  async #reloadWindow(): Promise<void> {
    const sessionFile = this.#sessionFile;
    if (sessionFile === null) return;
    if (this.#leaf === null) {
      this.store.setWindow([], false);
      return;
    }
    const window = await this.client.port(SessionFileStore).readEntryWindow({
      sessionFile,
      ...(this.#leaf === undefined ? {} : { leafId: this.#leaf as EntryId }),
      byteBudget: FIRST_WINDOW_BYTES,
    });
    if (this.#disposed) return;
    const entries = window.entries as unknown as SessionEntry[];
    this.store.setWindow(entries, window.hasOlder);
    this.#windowRead = true;
    // The branch the file ends on is what opening the chat shows next time (not a branch an edit went back to).
    if (this.#leaf === undefined && this.#threadId !== null)
      keepWindow(this.#threadId, { entries, hasOlder: window.hasOlder });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#stopResync();
    this.#draft.dispose();
    this.store.dispose();
    // A stream that ended with its chat (a deleted chat) has nothing left to unsubscribe.
    await this.#subscription?.unsubscribe().catch(() => undefined);
    if (this.#threadId !== null) await this.#releaseView(this.#threadId);
  }

  /** Lets go of the view this pane's open took, once. */
  async #releaseView(threadId: ThreadId): Promise<void> {
    if (!this.#viewTaken) return;
    this.#viewTaken = false;
    // The server answers a chat it no longer has (deleted meanwhile) with nothing to do, and a lost connection has let
    // go of every view already, so a failure here leaves nothing held.
    await this.client
      .port(ChatSessionPort)
      .close({ threadId })
      .catch(() => undefined);
  }
}

/** A server that predates a method refuses its name: said in words a person acts on. */
function olderServer(failure: unknown, cannot: string): unknown {
  return failure instanceof AppFailure && failure.appError.code === "invalid_args"
    ? new Error(`This app server cannot ${cannot} yet; it needs an update.`)
    : failure;
}
