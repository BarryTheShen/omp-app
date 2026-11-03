import {
  AppFailure,
  type FolderPath,
  RUNNING_STOP_OTHER_VIEW,
  type RunningChat,
  type RunningChatState,
  RunningChatsPort,
  type SessionFilePath,
  type StreamKey,
  streamKey,
  type ThreadId,
} from "@omp-app/contracts";
import type { PortHandlerContext, PortRegistration } from "../../registry/ports";

/** A chat whose process the server holds, as the process registry has it. */
export interface HeldChat {
  readonly threadId: ThreadId;
  readonly folder: string;
  readonly busy: boolean;
  /** When omp's `/pause` paused it (epoch ms); null while it is not paused. */
  readonly pausedAt: number | null;
}

export interface RunningChatsContext {
  /** The chats whose process is held now, in every folder. */
  readonly held: () => readonly HeldChat[];
  /** Whether a chat waits for an answer from you: an approval or a question. */
  readonly waitingFor: (threadId: ThreadId) => boolean;
  /** Its name as the chat list shows it; null before omp has written its file. */
  readonly titleOf: (threadId: ThreadId) => Promise<string | null>;
  /** The session file it runs, known before omp writes it; undefined when the app does not know it. */
  readonly sessionFileOf: (threadId: ThreadId) => SessionFilePath | undefined;
  /** Each way the list can change: a process held or let go, a turn started or ended, a pause, a question. */
  readonly changes: readonly ((listener: () => void) => () => void)[];
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  /** The views each tab holds on a chat, and all of them: a stop counts the asking tab's own as its own. */
  readonly views: {
    viewsOf(threadId: ThreadId, connectionId: string): number;
    watcherCount(threadId: ThreadId): number;
  };
  /** Whether a chat's turn runs now; undefined for a chat with no process here. */
  readonly busyOf: (threadId: ThreadId) => boolean | undefined;
  /** Ends a chat's turn, as Esc does. */
  readonly abortTurn: (threadId: ThreadId, call: PortHandlerContext) => Promise<unknown>;
  /** Ends a chat's process, the asking tab's views counted as its own (the process registry's `stop`). */
  readonly stopChat: (threadId: ThreadId, ownViews: number) => Promise<void>;
  readonly now?: () => number;
  /** The wait between looks at a turn that is ending; a test gives its own. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Changes this close together go out as one event. */
const COALESCE_MS = 100;

/** How long a stop lets a turn end on its abort before the process ends it, and how often it looks. */
const TURN_END_MS = 10_000;
const TURN_LOOK_MS = 100;

const conflict = (message: string): AppFailure =>
  new AppFailure({ code: "conflict", message, retryable: true });

const ORDER: Record<RunningChatState, number> = { waiting: 0, working: 1, paused: 2, idle: 3 };

/** What a held chat does now: an answer it waits for comes first, then a pause, then a turn. */
const stateOf = (chat: HeldChat, waiting: boolean): RunningChatState =>
  waiting ? "waiting" : chat.pausedAt !== null ? "paused" : chat.busy ? "working" : "idle";

/**
 * The chats that run on the server, from every folder (D1): each with its folder, its name and what it does now, and
 * an event each time the list changes, so every device shows the same list.
 */
export function createRunningChatsRuntime(context: RunningChatsContext): {
  readonly registration: PortRegistration;
  readonly stop: () => void;
} {
  const now = context.now ?? Date.now;
  const sleep = context.sleep ?? ((ms: number) => Bun.sleep(ms));
  const changed = streamKey(RunningChatsPort.name, "changed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const announce = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      context.publish(changed, { at: now() });
    }, COALESCE_MS);
  };
  const stops = context.changes.map((subscribe) => subscribe(announce));

  const handlers = {
    list: async (): Promise<{ chats: RunningChat[] }> => {
      const chats = await Promise.all(
        context.held().map(
          async (chat): Promise<RunningChat> => ({
            threadId: chat.threadId,
            folder: chat.folder as FolderPath,
            title: await context.titleOf(chat.threadId).catch(() => null),
            sessionFile: context.sessionFileOf(chat.threadId) ?? null,
            state: stateOf(chat, context.waitingFor(chat.threadId)),
          }),
        ),
      );
      chats.sort(
        (left, right) =>
          ORDER[left.state] - ORDER[right.state] ||
          (left.title ?? "").localeCompare(right.title ?? "") ||
          left.threadId.localeCompare(right.threadId),
      );
      return { chats };
    },
    stop: async (args: unknown, call: PortHandlerContext): Promise<null> => {
      const { threadId } = args as { threadId: ThreadId };
      const own = context.views.viewsOf(threadId, call.connectionId);
      if (context.views.watcherCount(threadId) > own) throw conflict(RUNNING_STOP_OTHER_VIEW);
      const paused = context
        .held()
        .some((chat) => chat.threadId === threadId && chat.pausedAt !== null);
      // A turn that runs is asked to end, as Esc ends it, so omp finishes it itself; the process then ends it, ended or
      // not, after TURN_END_MS. The abort is not awaited: omp may answer it only once the turn is over. A paused turn
      // waits at omp's gate and goes with the process at once.
      if (context.busyOf(threadId) === true && !paused) {
        void context.abortTurn(threadId, call).catch(() => undefined);
        for (
          let waited = 0;
          context.busyOf(threadId) === true && waited < TURN_END_MS;
          waited += TURN_LOOK_MS
        ) {
          await sleep(TURN_LOOK_MS);
        }
      }
      await context.stopChat(threadId, own);
      return null;
    },
  };

  return {
    registration: { port: RunningChatsPort, context, handlers },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      for (const stop of stops) stop();
    },
  };
}
