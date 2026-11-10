import {
  type OpenQuestionsChat,
  type OpenQuestionsList,
  QuestionsPort,
  type StreamKey,
  streamKey,
  type ThreadId,
} from "@omp-app/contracts";
import type { OpenQuestions } from "../../questions/open-questions";
import type { PortRegistration } from "../../registry/ports";
import type { WaitingAsks } from "./chat-session";

export interface QuestionsContext {
  readonly questions: OpenQuestions;
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
 * The questions that wait for you in every chat (D7): those its agent asked without waiting and omp's questions that
 * stop a chat until you answer, each chat's together, the chat asked most recently first; and `changed` to every device.
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
  const stopQuestions = context.questions.subscribe(schedule);
  const stopWaiting = context.waiting.onWaitingChange(schedule);
  const handlers = {
    list: async (): Promise<OpenQuestionsList> => {
      const chats = new Map<ThreadId, { latest: number; chat: Omit<OpenQuestionsChat, "title"> }>();
      for (const chat of context.questions.list()) {
        chats.set(chat.threadId, {
          latest: Math.max(...chat.records.map((record) => record.askedAt)),
          chat: {
            threadId: chat.threadId,
            folder: chat.folder,
            records: [...chat.records],
            requests: [],
          },
        });
      }
      for (const asks of context.waiting.asks()) {
        const known = chats.get(asks.threadId);
        chats.set(asks.threadId, {
          latest: Math.max(known?.latest ?? 0, asks.at),
          chat: {
            threadId: asks.threadId,
            folder: known?.chat.folder ?? asks.folder,
            records: known?.chat.records ?? [],
            requests: [...asks.requests],
          },
        });
      }
      const ordered = [...chats.values()].sort((left, right) => right.latest - left.latest);
      return {
        chats: await Promise.all(
          ordered.map(async ({ chat }) => ({
            ...chat,
            title: await context.titleOf(chat.threadId).catch(() => null),
          })),
        ),
      };
    },
    dismiss: (args: unknown): null => {
      context.questions.dismiss((args as { threadId: ThreadId }).threadId);
      return null;
    },
  };
  return {
    registration: { port: QuestionsPort, context, handlers },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      stopQuestions();
      stopWaiting();
    },
  };
}
