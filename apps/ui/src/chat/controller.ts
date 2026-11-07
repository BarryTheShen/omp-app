import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { AppClient, AppClientSubscription } from "@omp-app/client";
import {
  AppFailure,
  AppPort,
  type ChatSessionClient,
  type ChatSessionEvent,
  ChatSessionPort,
  type EntryId,
  type FileSearchCandidate,
  FileSearchPort,
  FolderPath,
  firstPromptTextOf,
  type McpCommandServerSummary,
  McpCommandsPort,
  type SessionEntryWindow,
  SessionFilePath,
  SessionFileStore,
  SharesPort,
  type SubagentReadResult,
  type SubagentTranscript,
  type ThreadId,
  WorkspaceFilesPort,
  WorkspaceRelativePath,
} from "@omp-app/contracts";
import {
  type AnswerQuestionParams,
  type AssignModelRoleParams,
  type ChatHostCommand,
  type ChatHostImage,
  type ChatHostMethod,
  type ChatHostMethodMap,
  type ClearModelRoleParams,
  type CompactionPointParams,
  type ExtensionCompletion,
  type GoalParams,
  type HostDialogAnswer,
  isHostDialogRequest,
  type JobDetail,
  type JobList,
  type LoginProvider,
  type LoginResult,
  type McpReauthResult,
  type ModelHub,
  type PlanFile,
  type ProviderAccounts,
  type QuestionRecord,
  type QueuedMessage,
  type QueueName,
  type RoleModel,
  type SubagentSnapshot,
  ThinkingLevelParams,
} from "@omp-app/contracts/chat-host";
import { AgentHubState } from "../agents/hub-state";
import { type BtwRecord, BtwStore, withBtwCommand } from "../btw/btw";
import { follow } from "../follow";
import { type Attention, AttentionTracker } from "../inbox/attention";
import { lastSeen } from "../lastSeen";
import { pageHost } from "../lite/lite";
import { ModelHubToggle } from "../models/hub";
import { type ModelPreferencesStore, modelPreferencesFor } from "../models/preferences";
import { keepBothName } from "../panels/files/names";
import { downloadBytes, readFileBytes, uploadBlob } from "../panels/files/transfer";
import { clientTags, frameMarks, watchFrames } from "../perf/frames";
import { isPhone } from "../phone";
import { QuestionsStore } from "../questions/questions";
import { keepShareLink } from "../shares/link";
import { ChatDraft } from "./drafts";
import { noteFirstPrompt } from "./firstPrompts";
import { openFailureText } from "./openFailure";
import { type ChatModel, ChatStore, type PlanProposal, toChatModel } from "./store";
import type { ShellRun } from "./triggers";
import { cachedWindow, keepWindow } from "./windowCache";

/** The first window read from a session file: enough for the newest screens, small enough to parse at once. */
const FIRST_WINDOW_BYTES = 512 * 1024;
/**
 * A phone's first window: a phone shows a dozen messages, older ones load as the reader scrolls up, and its connection is
 * often slow and relayed, where the window is most of what an open waits for (#2785).
 */
const PHONE_FIRST_WINDOW_BYTES = 128 * 1024;

/** How much of a chat's file its first window reads on this device. */
export function firstWindowBytes(): number {
  return isPhone() ? PHONE_FIRST_WINDOW_BYTES : FIRST_WINDOW_BYTES;
}

/** A chat's side questions as the panel showed them last, for this page: shown at once while omp's are read (#2785). */
const keptBtw = (threadId: string) => lastSeen<readonly BtwRecord[]>(`btw:${threadId}`);
/** An older window, read as the reader nears the top: a phone's as small as its first, for the same reason (#2768). */
const OLDER_WINDOW_BYTES = 1024 * 1024;
const PHONE_OLDER_WINDOW_BYTES = 128 * 1024;

/** A chat's usage for the side panel: omp's session statistics (its `/session` numbers) and the last reply's speed. */
export interface ChatUsage {
  readonly stats: ChatHostMethodMap["get_session_stats"]["result"];
  /** Output tokens per second of the last reply; null when omp has none to tell. */
  readonly tokensPerSecond: number | null;
}

/** A thinking level by its name, as omp's `set_thinking_level` takes it ("off", "low", …). */
export type ThinkingLevelName = ChatHostMethodMap["set_thinking_level"]["params"]["level"];

export type ChatTarget =
  | {
      readonly kind: "existing";
      readonly threadId: ThreadId;
      /** Null for a chat whose first reply still runs: omp writes its file once that reply is done. */
      readonly sessionFile: SessionFilePath | null;
      /** The folder it runs in when that is not the list's: a running chat opened from another folder (D1). */
      readonly folder?: FolderPath;
    }
  | { readonly kind: "new"; readonly folder: FolderPath };

/**
 * A transcript beside the chat's file that records an end, as a row of omp's roster: the outcome omp recorded in the
 * parent's task result wins, else the transcript's own end. One that records none may still run, and omp's roster has
 * it while it does.
 */
function endedAgent(transcript: SubagentTranscript): SubagentSnapshot[] {
  const status = transcript.recordedStatus ?? transcript.status;
  if (status === "unknown" || transcript.endedAt === null) return [];
  const endedAt = Date.parse(transcript.endedAt);
  if (!Number.isFinite(endedAt)) return [];
  return [
    {
      id: transcript.agentId,
      index: 0,
      agent: transcript.agent ?? "",
      // A transcript does not record where its agent type came from; nothing shows it.
      agentSource: "bundled",
      status: status === "stopped" ? "aborted" : status,
      sessionFile: transcript.sessionFile,
      lastUpdate: endedAt,
    },
  ];
}

/**
 * One open chat: its store, its chat host and its event stream. Opening paints the newest entries of the session file
 * before omp is up, then starts or joins the chat's host and follows its events, asking for streaming deltas.
 */
export class ChatController {
  readonly store = new ChatStore();
  /** omp's `/btw` side questions of the chat, and their sheet; omp's status lines about them show as toasts. */
  readonly btw = new BtwStore((text) => this.store.toast(text, "info"));
  /** The questions the chat's agent asked without waiting (`ask_async`), for the BTW panel; a new one is said in a toast. */
  readonly questions = new QuestionsStore((text) => this.store.toast(text, "info"));
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
  /** When this controller began, for the times its open reports (`#mark`). */
  readonly #createdAt = performance.now();
  /** Each step of the open, in milliseconds since `#createdAt`; reported into the server's log once the chat is live. */
  readonly #marks: Record<string, number> = {};
  /** The page's frames while the chat opens, from the start of `#open` until the chat is live. */
  #openFrames: ReturnType<typeof watchFrames> | null = null;
  /** The page was hidden at some moment of the open (its frames then say nothing about how it draws). */
  #hiddenDuringOpen = false;
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
  /** The open's own `open` call has answered: from then on a view let go is taken back with a call of its own. */
  #openAnswered = false;
  /** The page keeps this chat while no pane shows it, holding no view (see `park`). */
  #parked = false;
  /** Events before the subscription is acknowledged are the server's replay: history, not new requests. */
  #live = false;
  /**
   * The server's replay at the open, for the open's trace (#2768): how many events came before the subscription was
   * acknowledged, and their size as JSON. A slow link shows the subscription waiting on them.
   */
  #replayEvents = 0;
  #replayBytes = 0;
  /** The replay held a turn's end: its turn may be newer than the file's window (see `#open`). */
  #replayEndedTurn = false;
  #commands: Promise<readonly ChatHostCommand[]> | null = null;
  /** The roles Ctrl+P walks, in omp's `cycleOrder`, as last read; empty until read. */
  #roleOrder: readonly string[] = [];
  /** The server answers no role methods (it predates them): Ctrl+P says so instead of failing. */
  #noRoles = false;
  readonly #stopResync: () => void;
  /** Stops following when the app continues this chat after a usage limit (#2781). */
  #stopContinue: (() => void) | null = null;
  /** Stops following this chat's usage pause (#2781 part 3). */
  #stopUsagePause: (() => void) | null = null;
  /** Stops following the services this chat started that were shared (#2788). */
  #stopShares: (() => void) | null = null;
  /** Each shared service's one-time link, kept fresh for the chat's row. */
  readonly #shareLinks = new Map<string, ReturnType<typeof keepShareLink>>();
  /** The chat's own folder on the server (`localFolder`), with the chat it was asked for. */
  #localFolder: { readonly threadId: ThreadId; readonly folder: Promise<FolderPath> } | null = null;
  /** The app's client: the pane opens a page the chat wrote through its shares (#2836). */
  readonly client: AppClient;
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

  readonly #insertListeners = new Set<(text: string) => void>();

  /** Puts `text` into the chat's message box at its caret (the Files panel's Mention in chat, #2782). */
  insertText(text: string): void {
    for (const listener of this.#insertListeners) listener(text);
  }

  /** The message box hears text asked into it; returns the stop. */
  onInsertText(listener: (text: string) => void): () => void {
    this.#insertListeners.add(listener);
    return () => this.#insertListeners.delete(listener);
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

  /**
   * Opens the chat for this pane. A failure is said in the transcript, with what to do when omp stopped as it started;
   * a pane that went away meanwhile says nothing.
   */
  async open(): Promise<void> {
    try {
      await this.#open();
    } catch (failure) {
      if (this.#disposed) return;
      this.store.addNotice(openFailureText(failure), "error");
      this.store.setPhase("ended");
    }
  }

  async #open(): Promise<void> {
    this.#openFrames = watchFrames(() => {
      if (document.visibilityState === "hidden") this.#hiddenDuringOpen = true;
    });
    const chat = this.client.port(ChatSessionPort);
    // The server's open goes out at once, beside the read of the file's window: the chat's omp starts, or the running
    // one is joined, while its file is read (#2768). The subscription still waits for the window, so live events follow
    // it. Awaited below; a failure meanwhile is not left unhandled.
    const opening = chat.open(
      this.target.kind === "existing"
        ? { threadId: this.target.threadId }
        : { folderPath: this.target.folder, start: "new" },
    );
    opening.catch(() => undefined);
    if (this.#sessionFile !== null) {
      // A chat opened before shows what this browser kept of it at once; the file's window replaces it when it comes.
      const fromFile = this.#reloadWindow();
      const threadId = this.#threadId;
      const kept = threadId === null ? undefined : await cachedWindow(threadId);
      if (kept !== undefined && !this.#windowRead && !this.#disposed) {
        this.store.setWindow(kept.entries, kept.hasOlder);
        this.#mark("kept_window_ms");
      }
      try {
        await fromFile;
      } catch (failure) {
        // The open went out already: the view it took goes with the failure.
        opening.then(
          (opened) => {
            this.#viewTaken = true;
            return this.#releaseView(opened.threadId);
          },
          () => undefined,
        );
        throw failure;
      }
      this.#mark("file_window_ms");
    }
    const opened = await opening;
    this.#viewTaken = true;
    this.#openAnswered = true;
    this.#mark("open_ms");
    if (this.#disposed) {
      await this.#releaseView(opened.threadId);
      return;
    }
    // Kept by the page before its open answered: it holds no view while no pane shows it.
    if (this.#parked) void this.#releaseView(opened.threadId);
    this.#threadId = opened.threadId;
    if (this.target.kind === "new") this.#draft.keepFor(opened.threadId);
    this.#sessionFile = opened.sessionFile;
    // The setup goes out with the subscription, not after its answer (#2768): none of it needs the subscription, so the
    // chat is live a round trip sooner, and the store's marks judge a state read asked before the replay (`setState`).
    // The answers come together: the chat is live after the slowest, not after their sum (#2760). omp's ask tool then
    // sends all its questions in one request, with their checkboxes and typed answers; without the ask dialog, omp asks
    // each question as a plain choice, which still works.
    const subscribing = this.client.subscribe(ChatSessionPort, "event", {
      scope: opened.threadId,
      afterSeq: 0,
      onEvent: (payload) => this.#onEvent(payload),
    });
    const marked = <T>(mark: string, step: Promise<T>): Promise<T> =>
      step.then((value) => {
        this.#mark(mark);
        return value;
      });
    const setup = Promise.all([
      marked(
        "event_options_ms",
        chat.setEventOptions({ threadId: opened.threadId, messageUpdates: "delta" }),
      ),
      marked(
        "ask_dialog_ms",
        this.#request("set_ask_dialog", { enabled: true }).catch(() => undefined),
      ),
      marked("state_ms", this.#refreshState()),
    ]);
    // Awaited after the subscription; a failure meanwhile is not left unhandled.
    setup.catch(() => undefined);
    this.#subscription = await subscribing;
    if (this.#disposed) {
      await this.#subscription.unsubscribe();
      return;
    }
    this.#live = true;
    this.#mark("subscribed_ms");
    // A turn that ended after the file's window was read came in the replay with no omp entry ids: the window is read
    // once more for it. Turns the window held already need nothing (#2768).
    if (this.#replayEndedTurn && this.store.beyondWindow) this.#refreshWindow();
    await setup;
    if (this.#disposed) return;
    this.store.setPhase("live");
    this.#mark("live_ms");
    this.#reportTimes();
    const unshown = (what: string) => (failure: unknown) => {
      if (this.#disposed) return;
      this.store.addNotice(
        `${what}: ${failure instanceof Error ? failure.message : String(failure)}`,
        "warning",
      );
    };
    // A read the link dropped under (the phone locked right after the chat opened, its link dead on waking) is made once
    // more on the new link, which it waits for, as the window's is (#2813).
    const onTheLink = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (failure) {
        if (
          this.#disposed ||
          !(failure instanceof AppFailure && failure.appError.code === "unavailable")
        )
          throw failure;
        return read();
      }
    };
    // The dialogs the server still holds open, read once the subscription holds, so one opened since comes as an event
    // (a replayed history cannot tell open dialogs from answered ones). They come beside the box, not before it (#2768).
    onTheLink(() => chat.openRequests({ threadId: opened.threadId }))
      .then((open) => {
        if (!this.#disposed)
          this.store.restoreRequests(open.map((item) => item.request).filter(isHostDialogRequest));
      })
      .catch(unshown("The questions waiting in this chat are not shown"));
    // The questions the agent asked without waiting, for the BTW panel and the rail's count. A chat still on an omp from
    // before them has none to show.
    onTheLink(() => this.loadQuestions()).catch(() => undefined);
    // What the chat's extensions show beside the box (#2842): the server keeps the latest of each, and a change since the
    // read comes as an event, as the dialogs' do.
    onTheLink(() => chat.uiState({ threadId: opened.threadId }))
      .then((state) => {
        if (!this.#disposed) this.store.restoreUiState(state.map((item) => item.event));
      })
      .catch(unshown("What this chat's extensions show is not shown"));
    onTheLink(() => this.#followAgents(opened.threadId)).catch(
      unshown("This chat's subagents are not shown"),
    );
    onTheLink(() => this.#readModes()).catch(unshown("Plan mode and the goal are not shown"));
    onTheLink(() => this.#refreshRole()).catch(() => undefined);
    this.#followContinue();
    this.#followUsagePause();
    this.#followShares();
  }

  /**
   * A service this chat started is shared by itself (#2788): the chat gets a row that says so, with its link. When the
   * shares change (one ended, say), each link is made again, so a row whose share ended says so at once (#2836).
   */
  #followShares(): void {
    const stopShared = follow(this.client.subscribe(SharesPort, "sharedForChat"), (shared) => {
      if (shared.threadId !== this.#threadId || this.#shareLinks.has(shared.share.id)) return;
      this.store.addShareNotice(
        `${shared.program ?? "A service"} is listening on port ${shared.share.port}. It opens on your paired devices.`,
        shared.share.id,
      );
      this.#shareLinks.set(
        shared.share.id,
        keepShareLink(this.client, shared.share.id, (url, ended) =>
          this.store.setShareLink(shared.share.id, url, ended),
        ),
      );
    });
    const stopChanged = follow(this.client.subscribe(SharesPort, "changed"), () => {
      for (const link of this.#shareLinks.values()) link.refresh();
    });
    this.#stopShares = () => {
      stopShared();
      stopChanged();
    };
  }

  /** A share's link in the chat was followed: its ticket is taken, so a new one is made. */
  shareLinkUsed(shareId: string): void {
    this.#shareLinks.get(shareId)?.used();
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

  /**
   * When the app continues this chat by itself after a usage limit (#2781): read once, then followed. A change heard
   * before the read answers is newer than it. A server older than this has neither, and the row offers Retry alone.
   */
  #followContinue(): void {
    let heard = false;
    this.#stopContinue = follow(
      this.client.subscribe(SessionFileStore, "continueChanged"),
      (change) => {
        if (change.id !== this.#threadId) return;
        heard = true;
        this.store.setContinuesAt(change.continuesAt);
      },
    );
    this.client
      .port(SessionFileStore)
      .listContinuing({ folder: this.folder })
      .then((listed) => {
        if (this.#disposed || heard) return;
        const mine = listed.chats.find((chat) => chat.id === this.#threadId);
        this.store.setContinuesAt(mine?.continuesAt ?? null);
      })
      .catch(() => undefined);
  }

  /**
   * This chat's usage pause (#2781 part 3): read once, then followed, as the continue above. A server older than this has
   * neither, and the chat's menu does not offer it.
   */
  #followUsagePause(): void {
    let heard = false;
    this.#stopUsagePause = follow(
      this.client.subscribe(SessionFileStore, "usagePauseChanged"),
      (change) => {
        if (change.id !== this.#threadId) return;
        heard = true;
        // A chat a usage rule holds has a hold and no mark (#2836); neither, and it has no usage pause.
        this.store.setUsagePause(
          change.percent === null && change.hold === null
            ? null
            : { percent: change.percent, hold: change.hold },
        );
      },
    );
    this.client
      .port(SessionFileStore)
      .listUsagePauses({ folder: this.folder })
      .then((listed) => {
        if (this.#disposed || heard) return;
        const mine = listed.chats.find((chat) => chat.id === this.#threadId);
        this.store.setUsagePause(
          mine === undefined ? null : { percent: mine.percent, hold: mine.hold },
        );
      })
      .catch(() => undefined);
  }

  /** "Don't continue": the app leaves this chat stopped after its usage limit (#2781). */
  async cancelContinue(): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null) return;
    await this.client.port(ChatSessionPort).cancelContinue({ threadId });
  }

  /**
   * Marks this chat to pause when its provider's 5-hour usage reaches `percent`, or unmarks it (`null`) (#2781 part 3).
   * The server keeps the mark, so every device sees it.
   */
  async setUsagePause(percent: number | null): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === null)
      throw new Error("Send a first message, then set the chat's usage pause.");
    await this.client.port(ChatSessionPort).setUsagePause({ threadId, percent });
  }

  #mark(step: string): void {
    this.#marks[step] ??= Math.round(performance.now() - this.#createdAt);
  }

  /**
   * The steps of this open and when each ended, into the server's log as a `trace` line (numbers only), so a slow
   * open shows where its time went: the browser's copy shown, the file's window, the server's open, the subscription,
   * omp's first answers (`state_ms`: a new omp's start), and the box usable; with the page's frames meanwhile (a long
   * frame is the page busy, so a step that waited on it took long without the server being slow).
   */
  #reportTimes(): void {
    const frames = this.#openFrames?.stop();
    this.#openFrames = null;
    const marks = {
      ...this.#marks,
      ...(frames === undefined ? {} : frameMarks(frames)),
      new_chat: this.target.kind === "new" ? 1 : 0,
      replay_events: this.#replayEvents,
      replay_kb: Math.round(this.#replayBytes / 1024),
      hidden: this.#hiddenDuringOpen ? 1 : 0,
    };
    void this.client
      .port(AppPort)
      .reportClientTrace({
        marks,
        gaps: [...(frames?.longGaps ?? [])],
        supported: ["chat-open", ...clientTags()],
      })
      .catch(() => undefined);
  }

  /** Plan mode switches so far: an answer about plan mode counts only while no later switch is on its way. */
  #planSwitches = 0;
  /** This page's plan mode switches omp has not answered yet: the answer to the latest decides the chip meanwhile. */
  #planSwitchesPending = 0;
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

  /**
   * omp's roster of this chat's subagents, kept current by its lifecycle and progress events, with the ones that ended
   * before: omp's roster forgets them when the chat's omp starts again, but their transcripts stay beside its file.
   */
  async #followAgents(threadId: ThreadId): Promise<void> {
    await this.client
      .port(ChatSessionPort)
      .setSubagentSubscription({ threadId, level: "progress" });
    const [{ subagents }, ended] = await Promise.all([
      this.#request("get_subagents", {}),
      this.#endedAgents(),
    ]);
    if (this.#disposed) return;
    const live = new Set(subagents.map((agent) => agent.id));
    this.store.setAgents([...ended.filter((agent) => !live.has(agent.id)), ...subagents]);
  }

  /** The subagents whose transcripts beside the chat's file record an end; none before omp has written the file. */
  async #endedAgents(): Promise<SubagentSnapshot[]> {
    const sessionFile = this.#sessionFile;
    if (sessionFile === null) return [];
    try {
      const { transcripts } = await this.client
        .port(SessionFileStore)
        .listSubagents({ sessionFile });
      return transcripts.flatMap(endedAgent);
    } catch (failure) {
      if (failure instanceof AppFailure && failure.appError.code === "not_found") return [];
      throw failure;
    }
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
    if (this.target.kind === "new" && this.#threadId !== null)
      // Named as the server names it: what was typed, or the files' names when only files were sent (#2830).
      noteFirstPrompt(this.#threadId, firstPromptTextOf(text));
    // From another app's side panel, the message names that app, for its extensions (`host`, the lite view's).
    const message = {
      text,
      ...(images.length > 0 ? { images: [...images] } : {}),
      ...(pageHost !== null ? { host: pageHost } : {}),
    };
    const behind = { streamingBehavior: mode === "followUp" ? "followUp" : "steer" } as const;
    if (this.store.getSnapshot().working) {
      await this.#request("prompt", { ...message, ...behind });
      return;
    }
    try {
      // The turn's starts and ends seen so far: one seen by the time the answer comes means the message is already in
      // the chat (omp starts later turns at once).
      const asked = this.store.activityMark.turn;
      const answer = await this.#request("prompt", message);
      // A message that starts a turn shows at once, with the chat working, though omp may take seconds to start it (its
      // first turn recalls memories, #2828); a paused chat holds it instead (the box's paused row).
      if (
        answer.resultFollows &&
        this.store.activityMark.turn === asked &&
        this.store.getSnapshot().pausedAt === null
      )
        this.store.sendStarted(text, images);
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

  /**
   * Stops the reply as omp's Escape does: every queued message comes back, in order, with its pictures, for the message
   * box.
   */
  async stop(): Promise<readonly QueuedMessage[]> {
    if (this.#threadId === null) return [];
    const restored = await this.#request("abort_and_restore_queue", {});
    return [...restored.steering, ...restored.followUp];
  }

  /**
   * Holds every agent of the chat (main, subagents, advisor) at its next step, as omp's `/pause` does: a reply or tool
   * already under way finishes, nothing new starts. Every viewer hears it (`pause_changed`).
   */
  async pause(): Promise<void> {
    if (this.#threadId === null) return;
    await this.#pauseOrResume("pause");
  }

  /** Releases the pause: held agents go on, and queued messages send. */
  async resume(): Promise<void> {
    if (this.#threadId === null) return;
    await this.#pauseOrResume("resume");
  }

  async #pauseOrResume(method: "pause" | "resume"): Promise<void> {
    try {
      await this.#request(method, {});
    } catch (failure) {
      // A chat still on an omp from before pause (one an update found running) moves to the new omp once its reply ends.
      if (failure instanceof AppFailure && failure.appError.omp?.code === "unknown_method") {
        throw new Error(OLDER_OMP);
      }
      throw failure;
    }
  }

  /** Takes a queued message back out of its queue, with its pictures; null when omp already delivered it. */
  async takeQueued(message: string, queue: QueueName): Promise<QueuedMessage | null> {
    const result = await this.#request("remove_queued_message", { message, queue });
    if (!result.removed) return null;
    return { text: result.text, ...(result.images === undefined ? {} : { images: result.images }) };
  }

  /**
   * The chat's own folder on the server, omp's `local://` (#2830), where files attached to a message go: asked once per
   * chat, and again after a failure.
   */
  localFolder(): Promise<FolderPath> {
    const threadId = this.#threadId;
    if (threadId === null) return Promise.reject(new Error("The chat is not open yet."));
    const known = this.#localFolder;
    if (known !== null && known.threadId === threadId) return known.folder;
    const folder: Promise<FolderPath> = this.#request("local_folder", {}).then(
      (answer) => FolderPath.parse(answer.folder),
      (failure: unknown) => {
        if (this.#localFolder?.folder === folder) this.#localFolder = null;
        // The chat's omp started before the update (it moves to the new one once settled), or the server is older.
        if (failure instanceof AppFailure && failure.appError.omp?.code === "unknown_method") {
          throw new Error(OLDER_OMP_FILES);
        }
        throw olderServer(failure, "take files");
      },
    );
    this.#localFolder = { threadId, folder };
    return folder;
  }

  /**
   * Uploads a file attached to a message into the chat's folder, under its own name, or `name (n).ext` when the folder or
   * `reserved()` (the box's other files, read as the name is chosen) holds that name; `onName` hears it at once, so two
   * files picked together never take one name. Returns the name.
   */
  async uploadAttachment(
    file: File,
    options: {
      readonly reserved: () => ReadonlySet<string>;
      readonly signal: AbortSignal;
      readonly onName: (name: string) => void;
      readonly onProgress: (sent: number) => void;
    },
  ): Promise<string> {
    const folder = await this.localFolder();
    const files = this.client.port(WorkspaceFilesPort);
    const listed = await files.list({ folder, showIgnored: true });
    const taken = new Set([...listed.entries.map((entry) => entry.name), ...options.reserved()]);
    const wanted = file.name === "" ? "file" : file.name;
    const name = taken.has(wanted) ? keepBothName(wanted, taken) : wanted;
    options.onName(name);
    // Read a chunk at a time as it goes (a phone never holds a big file whole), never over a file already there: one
    // that appeared meanwhile fails the upload instead.
    await uploadBlob(files, folder, WorkspaceRelativePath.parse(name), file, {
      expectedHash: null,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    return name;
  }

  /** Takes a file this page uploaded, then took out of the box before sending, out of the chat's folder (to the trash). */
  async removeAttachment(name: string): Promise<void> {
    const folder = await this.localFolder();
    await this.client
      .port(WorkspaceFilesPort)
      .trash({ folder, path: WorkspaceRelativePath.parse(name) });
  }

  /** Saves a file of the chat's folder (one a sent message names) to this device. */
  async downloadAttachment(name: string): Promise<void> {
    const folder = await this.localFolder();
    const files = this.client.port(WorkspaceFilesPort);
    const path = WorkspaceRelativePath.parse(name);
    const [{ mediaType }, read] = await Promise.all([
      files.stat({ folder, path }),
      readFileBytes(files, folder, path),
    ]);
    downloadBytes(read.bytes, name, mediaType);
  }

  async models(): Promise<readonly ChatModel[]> {
    const { models } = await this.#request("get_available_models", {});
    return models.map(toChatModel);
  }

  /**
   * What the model menu lists: omp's models, each provider's newest first, and the ones omp used most recently
   * (`provider/id`, newest first). An app server older than the menu gives omp's models as they come, with none recent.
   */
  async modelMenu(): Promise<{
    readonly models: readonly ChatModel[];
    readonly recent: readonly string[];
  }> {
    try {
      const menu = await this.#request("get_model_menu", {});
      return {
        models: menu.models.map((model) => ({
          provider: model.provider,
          id: model.modelId,
          name: model.name,
        })),
        recent: menu.recent,
      };
    } catch (failure) {
      if (!(failure instanceof AppFailure && failure.appError.code === "invalid_args"))
        throw failure;
      return { models: await this.models(), recent: [] };
    }
  }

  /** The model menu's stars and hidden models: the server's, the same for every pane and device. */
  get modelPreferences(): ModelPreferencesStore {
    return modelPreferencesFor(this.client);
  }

  /** omp's sign-in providers, and whether each has a sign-in stored. */
  async loginProviders(): Promise<readonly LoginProvider[]> {
    return (await this.#request("get_login_providers", {})).providers;
  }

  /**
   * Signs in to a provider through this chat's omp. omp sends the page to open (the store's `signIn`) and may ask for
   * a code as one of its questions; this ends when the sign-in does, and answers whether it was cancelled.
   */
  async login(providerId: string): Promise<LoginResult> {
    try {
      return await this.#request("login", { providerId });
    } finally {
      this.store.clearSignIn();
    }
  }

  /** Stops the sign-in running in this chat, a provider's or an MCP server's (#2784); answers whether one ran. */
  async cancelSignIn(): Promise<boolean> {
    return (await this.#request("cancel_sign_in", {})).cancelled;
  }

  /** omp's MCP servers as this chat's omp lists them (its `/mcp list`); none before the chat is open. */
  async mcpServers(): Promise<readonly McpCommandServerSummary[]> {
    const threadId = this.#threadId;
    if (threadId === null) return [];
    return (await this.client.port(McpCommandsPort).servers({ threadId })).servers;
  }

  /**
   * Signs in to an MCP server again through this chat's omp (#2779 D6.2): the server's page opens on this device (the
   * store's `signIn`), and the address the browser ends on is asked for as one of the chat's questions.
   */
  async mcpReauth(name: string): Promise<McpReauthResult> {
    try {
      return await this.#request("mcp_reauth", { name });
    } finally {
      this.store.clearSignIn();
    }
  }

  /** The accounts omp stores for a provider, and another source of its sign-in when there is one. */
  async providerAccounts(providerId: string): Promise<ProviderAccounts> {
    return await this.#request("get_provider_accounts", { providerId });
  }

  /** Signs one stored account out of omp; answers whether it was still stored, and the provider's accounts after. */
  async logoutAccount(
    providerId: string,
    credentialId: number,
  ): Promise<ProviderAccounts & { readonly removed: boolean }> {
    return await this.#request("logout_account", { providerId, credentialId });
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

  /** The thinking levels omp offers for the chat's model: `off`, then the model's own, in their order. */
  async thinkingLevels(): Promise<readonly ThinkingLevelName[]> {
    const { levels } = await this.#request("get_available_thinking_levels", {});
    return levels.map((level): ThinkingLevelName => `${level}`);
  }

  /** Sets omp's thinking level for the chat's model to one of `thinkingLevels`. */
  async setThinking(level: ThinkingLevelName): Promise<void> {
    await this.#request("set_thinking_level", { level });
    this.store.setThinkingLevel(level);
  }

  /** The chat's background jobs, running and recent (the Jobs tab); null when omp keeps none for it. */
  async jobs(): Promise<JobList | null> {
    return (await this.#request("get_jobs", {})).jobs;
  }

  /** One background job's command, output and exit code; null once omp no longer keeps it. */
  async inspectJob(jobId: string): Promise<JobDetail | null> {
    return (await this.#request("inspect_job", { jobId })).job;
  }

  /** Cancels one of the chat's own running background jobs; false when it no longer runs. */
  async cancelJob(jobId: string): Promise<boolean> {
    return (await this.#request("cancel_job", { jobId })).cancelled;
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
    // omp's answer names the role's model: the chip shows both at once, never the new role with the old model.
    this.store.switchRole(
      this.#roleOrder,
      switched.role,
      { provider: switched.provider, id: switched.modelId, name: switched.name },
      switched.thinkingLevel,
    );
  }

  /**
   * Switches the chat to a role's model, with the thinking level the role names, through omp's own role switch (only
   * this chat; the settings stay): the model menu's Roles (#2838). omp records the role, so it stays the chat's role
   * when another role has the same model; the chip changes in one step, as Ctrl+P's does. A server or a chat host from
   * before that switch gets the model and the level as two requests, and omp then tells the role from the model.
   */
  async useRole(role: RoleModel): Promise<void> {
    try {
      const used = await this.#request("use_role_model", { role: role.role });
      if (used !== null)
        this.store.switchRole(
          [],
          used.role,
          { provider: used.provider, id: used.modelId, name: used.name },
          used.thinkingLevel,
        );
      await this.#refreshRole();
      return;
    } catch (failure) {
      if (!(failure instanceof AppFailure && failure.appError.code === "invalid_args"))
        throw failure;
    }
    await this.setModel({ provider: role.provider, id: role.modelId, name: role.name });
    const level = ThinkingLevelParams.safeParse({ level: role.thinkingLevel });
    if (level.success && level.data.level !== "inherit") await this.setThinking(level.data.level);
    await this.#refreshRole();
  }

  /** Reads the roles again (the model menu opening): another chat or omp's terminal may have changed them. */
  async refreshRoles(): Promise<void> {
    if (!this.#noRoles) await this.#refreshRole();
  }

  /**
   * The live model's role, the roles Ctrl+P switches between and their order (`get_role_models`); a server that
   * predates them gives none.
   */
  async #refreshRole(): Promise<void> {
    try {
      const roles = await this.#request("get_role_models", {});
      if (this.#disposed) return;
      this.#roleOrder = roles.order;
      this.store.setRole(roles.current, roles.roles);
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

  /** Sets a role's fallback chain, as omp's hub does (#2838): an empty chain clears it; the line omp shows for it. */
  async setRoleFallbacks(role: string, chain: readonly string[]): Promise<string> {
    try {
      const { status } = await this.#request("set_role_fallbacks", { role, chain: [...chain] });
      return status;
    } catch (failure) {
      throw olderServer(failure, "change fallbacks");
    }
  }

  /**
   * Saves, switches to or deletes one of omp's model presets, as omp's hub and `/modelpreset` do (#2838): the line omp
   * shows for it, and whether it went through whole (a switch to a preset that did not fully apply, a delete that
   * found nothing to delete, is not).
   */
  async modelPreset(
    action: "save" | "apply" | "delete",
    name: string,
  ): Promise<{ readonly status: string; readonly clean: boolean }> {
    try {
      if (action === "save") {
        const { status } = await this.#request("save_model_preset", { name });
        return { status, clean: true };
      }
      if (action === "apply") return await this.#request("apply_model_preset", { name });
      const { status, deleted } = await this.#request("delete_model_preset", { name });
      return { status, clean: deleted };
    } catch (failure) {
      throw olderServer(failure, "keep model presets");
    }
  }

  /** omp's line for a typed compaction limit of a model, as its hub shows it beside the field (#2838); null for text omp does not read. */
  async previewCompactionPoint(
    provider: string,
    modelId: string,
    input: string,
  ): Promise<string | null> {
    try {
      const { preview } = await this.#request("preview_compaction_point", {
        provider,
        modelId,
        input,
      });
      return preview;
    } catch (failure) {
      throw olderServer(failure, "set compaction limits");
    }
  }

  /**
   * Sets or removes a model's own compaction limit, as omp's hub does (#2838): omp's line once saved, or its warning
   * when the limit opens the model's larger window, which is written once sent again `confirmed`.
   */
  async setCompactionPoint(
    params: CompactionPointParams,
  ): Promise<
    | { readonly kind: "saved"; readonly status: string }
    | { readonly kind: "confirm"; readonly message: string }
  > {
    try {
      return await this.#request("set_compaction_point", params);
    } catch (failure) {
      throw olderServer(failure, "set compaction limits");
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
    const threadId = this.#threadId;
    const last = threadId === null ? undefined : keptBtw(threadId).get();
    if (last !== undefined && this.btw.getSnapshot().records === null) this.btw.setRecords(last);
    try {
      const { records } = await this.#request("get_btw_history", {});
      if (this.#disposed) return;
      this.btw.setRecords(records);
      if (threadId !== null) keptBtw(threadId).set(records);
    } catch (failure) {
      throw olderServer(failure, "answer side questions");
    }
  }

  /** Reads the questions the chat's agent asked without waiting (`ask_async`), open and answered. */
  async loadQuestions(): Promise<void> {
    try {
      const { questions } = await this.#request("get_questions", {});
      if (!this.#disposed) this.questions.setRecords(questions);
    } catch (failure) {
      throw olderQuestions(failure);
    }
  }

  /** Answers one: the answer goes to the agent as the person's message; resolves with the question, answered. */
  async answerQuestion(
    id: string,
    answer: Omit<AnswerQuestionParams, "id">,
  ): Promise<QuestionRecord> {
    try {
      const { record } = await this.#request("answer_question", { id, ...answer });
      this.questions.put(record);
      return record;
    } catch (failure) {
      throw olderQuestions(failure);
    }
  }

  /** Skips one: the agent is told to decide it itself. */
  async skipQuestion(id: string): Promise<QuestionRecord> {
    try {
      const { record } = await this.#request("skip_question", { id });
      this.questions.put(record);
      return record;
    } catch (failure) {
      throw olderQuestions(failure);
    }
  }

  /** Files and folders of the chat's folder that match an `@` mention. */
  async searchFiles(query: string): Promise<readonly FileSearchCandidate[]> {
    const found = await this.client
      .port(FileSearchPort)
      .search({ folder: this.folder, query, limit: 30 });
    return found.results;
  }

  /**
   * Rows omp's extensions offer for the box's text at the caret, as in omp's terminal menu: none when no extension adds
   * any, and none from a chat or server that predates them (the menu then shows the files alone).
   */
  async extensionCompletions(text: string, caret: number): Promise<readonly ExtensionCompletion[]> {
    if (this.#threadId === null) return [];
    try {
      return (await this.#request("extension_completions", { text, caret })).items;
    } catch {
      return [];
    }
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

  /**
   * One page of a subagent's transcript, its whole lines from `fromByte` on (at most 4 MiB a page), running or ended: the
   * server reads it beside the chat's file, so it needs no roster that still knows the subagent.
   */
  agentTranscript(sessionFile: string, fromByte: number): Promise<SubagentReadResult> {
    return this.client
      .port(SessionFileStore)
      .readSubagent({ sessionFile: SessionFilePath.parse(sessionFile), fromByte });
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
    this.#planSwitchesPending += 1;
    try {
      const request = this.#request("set_plan_mode", { enabled });
      this.#planSwitch = request.catch(() => undefined);
      const status = await request;
      if (!this.#disposed && switches === this.#planSwitches) this.store.setPlanMode(status);
    } catch (failure) {
      if (switches === this.#planSwitches) this.#readPlanMode().catch(() => undefined);
      throw failure;
    } finally {
      this.#planSwitchesPending -= 1;
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
        byteBudget: isPhone() ? PHONE_OLDER_WINDOW_BYTES : OLDER_WINDOW_BYTES,
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
    if (!this.#live) {
      this.#replayEvents += 1;
      this.#replayBytes += JSON.stringify(payload).length;
    }
    if (payload.kind === "moved") {
      this.#threadId = payload.threadId;
      this.#sessionFile = payload.sessionFile;
      if (this.target.kind === "new") this.#draft.keepFor(payload.threadId);
      this.btw.reset();
      this.questions.reset();
      void this.loadQuestions().catch(() => undefined);
    }
    // A side question's answer redraws its sheet only, not the chat; so does a question asked without waiting.
    if (payload.kind === "event" && this.btw.apply(payload.event)) return;
    if (payload.kind === "event" && this.questions.apply(payload.event, this.#live)) return;
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
    if (payload.event.type === "available_commands")
      this.#commands = Promise.resolve(withBtwCommand(payload.event.commands));
    // The server's replay at the open is history: the open reads the file's window before it, and omp's state, role and
    // plan mode after it, so its events ask for none of these again. Each replayed turn's end read the window anew, which
    // on a slow link made an open wait for several copies of it (#2768).
    if (!this.#live) {
      if (payload.event.type === "agent_end") this.#replayEndedTurn = true;
      return;
    }
    // A finished turn is read back from the file, so every entry shows with omp's own id.
    if (payload.event.type === "agent_end") this.#refreshWindow();
    if (payload.event.type === "model_changed") {
      this.#refreshState().catch(() => undefined);
      this.#refreshRole().catch(() => undefined);
    }
    // omp cleared finished todos on its own; the list it kept comes with the state.
    if (payload.event.type === "todo_auto_clear") this.#refreshState().catch(() => undefined);
    // Plan mode can change outside this pane (another tab, omp's own commands): read it again when omp settles.
    if (payload.event.type === "session_settled") this.#readPlanMode().catch(() => undefined);
    // Plan mode switched by another page, or by omp (an approved plan): shown here at once (#2812). While this page's
    // own switch waits for omp's answer, that answer decides.
    if (payload.event.type === "plan_mode_changed" && this.#planSwitchesPending === 0) {
      const { enabled, available, planFilePath } = payload.event;
      this.store.setPlanMode({
        enabled,
        available,
        ...(planFilePath === undefined ? {} : { planFilePath }),
      });
    }
  }

  /**
   * Reads the newest window again after omp wrote to the file; a new chat's file waits for omp's first reply. A read the
   * link dropped under (a phone asleep, a server restart) is made again on the new link, which it waits for.
   */
  #refreshWindow(retried = false): void {
    this.#reloadWindow().catch((error: unknown) => {
      if (error instanceof AppFailure && error.appError.code === "not_found") return;
      if (
        !retried &&
        !this.#disposed &&
        error instanceof AppFailure &&
        error.appError.code === "unavailable"
      ) {
        this.#refreshWindow(true);
        return;
      }
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
    let window: SessionEntryWindow;
    try {
      window = await this.client.port(SessionFileStore).readEntryWindow({
        sessionFile,
        ...(this.#leaf === undefined ? {} : { leafId: this.#leaf as EntryId }),
        byteBudget: firstWindowBytes(),
      });
    } catch (failure) {
      // omp writes a new chat's file once its first reply is done. Opened again before then (a reload, or the server
      // restarting while it replies) it has no entries yet, and what is live comes with its events; a chat that is gone
      // is said by its open.
      if (!(failure instanceof AppFailure && failure.appError.code === "not_found")) throw failure;
      if (this.#disposed) return;
      this.store.setWindow([], false);
      this.#windowRead = true;
      return;
    }
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
    this.#openFrames?.stop();
    this.#openFrames = null;
    this.#stopResync();
    this.#stopContinue?.();
    this.#stopUsagePause?.();
    this.#stopShares?.();
    for (const link of this.#shareLinks.values()) link.stop();
    this.#shareLinks.clear();
    this.#draft.dispose();
    this.store.dispose();
    // A stream that ended with its chat (a deleted chat) has nothing left to unsubscribe.
    await this.#subscription?.unsubscribe().catch(() => undefined);
    if (this.#threadId !== null) await this.#releaseView(this.#threadId);
  }

  /**
   * The page keeps this chat open while no pane shows it (`chatCache`): its transcript and live events stay, and the
   * view its pane took is let go, so another tab may delete the chat and the server's idle rule decides how long omp
   * stays up. `unpark` takes the view back.
   */
  async park(): Promise<void> {
    this.#parked = true;
    const threadId = this.#threadId;
    if (threadId !== null) await this.#releaseView(threadId);
  }

  /** A pane shows the kept chat again: it takes the view back, unless its first open is still under way and takes it. */
  async unpark(): Promise<void> {
    this.#parked = false;
    const threadId = this.#threadId;
    if (!this.#openAnswered || threadId === null || this.#viewTaken || this.#disposed) return;
    // Taken before the call answers, so a park meanwhile lets it go again (its close follows this open).
    this.#viewTaken = true;
    try {
      await this.client.port(ChatSessionPort).open({ threadId });
    } catch {
      this.#viewTaken = false;
      return;
    }
    if (this.#disposed || this.#parked) await this.#releaseView(threadId);
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

/** A chat whose omp predates questions without waiting, or a server that does: said in words a person acts on. */
function olderQuestions(failure: unknown): unknown {
  if (failure instanceof AppFailure && failure.appError.omp?.code === "unknown_method") {
    return new Error(
      "This chat still runs the omp from before the update, which keeps no questions. It moves to the new one once this reply ends.",
    );
  }
  return olderServer(failure, "keep questions");
}

/** The words for a chat still on an omp from before pause: the server moves it to the new omp once its reply ends. */
const OLDER_OMP =
  "This chat still runs the omp from before the update. It moves to the new one once this reply ends; Stop ends the reply now.";

/** The words for a file attached in a chat still on an omp from before files: it moves to the new omp once settled. */
const OLDER_OMP_FILES =
  "This chat still runs the omp from before the update, which takes no files. It moves to the new one once this reply ends; attach the file again then.";
