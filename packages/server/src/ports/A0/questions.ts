import {
  type OpenQuestionsList,
  QuestionsPort,
  type StreamKey,
  streamKey,
  type ThreadId,
} from "@omp-app/contracts";
import type { OpenQuestions } from "../../questions/open-questions";
import type { PortRegistration } from "../../registry/ports";

export interface QuestionsContext {
  readonly questions: OpenQuestions;
  /** A chat's name as the chat list shows it; null before omp named it. */
  readonly titleOf: (threadId: ThreadId) => Promise<string | null>;
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  readonly now?: () => number;
}

/** How long the changes of one moment are held to go out as one `changed`. */
const COALESCE_MS = 150;

/** The questions every chat's agent asked without waiting (D7): the list, and `changed` to every device. */
export function createQuestionsRuntime(context: QuestionsContext): {
  readonly registration: PortRegistration;
  readonly stop: () => void;
} {
  const now = context.now ?? Date.now;
  const changed = streamKey(QuestionsPort.name, "changed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopListening = context.questions.subscribe(() => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      context.publish(changed, { at: now() });
    }, COALESCE_MS);
  });
  const handlers = {
    list: async (): Promise<OpenQuestionsList> => ({
      chats: await Promise.all(
        context.questions.list().map(async (chat) => ({
          threadId: chat.threadId,
          folder: chat.folder,
          title: await context.titleOf(chat.threadId).catch(() => null),
          records: [...chat.records],
        })),
      ),
    }),
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
      stopListening();
    },
  };
}
