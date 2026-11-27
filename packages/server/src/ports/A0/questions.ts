import {
  type OpenQuestionsList,
  QuestionsPort,
  type StreamKey,
  streamKey,
  type ThreadId,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../registry/ports";
import type { WaitingAsks } from "./chat-session";

export interface QuestionsContext {
  /** omp's questions that stop each chat until you answer, and each change (the chat sessions' `waiting`). */
  readonly waiting: {
    asks(): readonly WaitingAsks[];
    onWaitingChange(listener: () => void): () => void;
  };
  /** A chat's name as the chat list shows it; null before omp named it. */
  readonly titleOf: (threadId: ThreadId) => Promise<string | null>;
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  readonly now?: () => number;
}

/** How long the changes of one moment are held to go out as one `changed`. */
const COALESCE_MS = 150;

/**
 * omp's questions that stop a chat until you answer, in every chat (D7): each chat's together, the chat asked most
 * recently first; and `changed` to every device.
 */
export function createQuestionsRuntime(context: QuestionsContext): {
  readonly registration: PortRegistration;
  readonly stop: () => void;
} {
  const now = context.now ?? Date.now;
  const changed = streamKey(QuestionsPort.name, "changed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      context.publish(changed, { at: now() });
    }, COALESCE_MS);
  };
  const stopWaiting = context.waiting.onWaitingChange(schedule);
  const handlers = {
    list: async (): Promise<OpenQuestionsList> => {
      const ordered = [...context.waiting.asks()].sort((left, right) => right.at - left.at);
      return {
        chats: await Promise.all(
          ordered.map(async (asks) => ({
            threadId: asks.threadId,
            folder: asks.folder,
            title: await context.titleOf(asks.threadId).catch(() => null),
            requests: [...asks.requests],
          })),
        ),
      };
    },
  };
  return {
    registration: { port: QuestionsPort, context, handlers },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      stopWaiting();
    },
  };
}
