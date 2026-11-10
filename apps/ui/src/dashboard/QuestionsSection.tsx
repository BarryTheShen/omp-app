import type { AppClient } from "@omp-app/client";
import {
  ChatSessionPort,
  type OpenQuestionsChat,
  OpenQuestionsList,
  QuestionsPort,
  type ThreadId,
} from "@omp-app/contracts";
import { isOmpQuestion, type QuestionRecord } from "@omp-app/contracts/chat-host";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatTarget } from "../chat/controller";
import { OmpQuestionCard } from "../chat/HostRequests";
import { follow } from "../follow";
import { lastSeen } from "../lastSeen";
import { type QuestionAnswerer, WaitingQuestions } from "../panels/btw/QuestionCard";
import { problemWords } from "./problems";

const LATER = "Questions from every chat come with the next server update.";

/** The list as this browser saw it last: shown at once, after a reload too, while it is read again. */
const kept = lastSeen<OpenQuestionsList>("open-questions", (stored) => {
  const parsed = OpenQuestionsList.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
});

/** Every chat's questions that wait, read again each time the server says they changed. */
function useOpenQuestions(client: AppClient): {
  readonly chats: readonly OpenQuestionsChat[] | null;
  readonly problem: string | null;
} {
  const [chats, setChats] = useState<readonly OpenQuestionsChat[] | null>(
    () => kept.get()?.chats ?? null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      client
        .port(QuestionsPort)
        .list({})
        .then(
          (listed) => {
            if (!active) return;
            kept.set(listed);
            setChats(listed.chats);
            setProblem(null);
          },
          (failure: unknown) =>
            active && setProblem(problemWords(failure, LATER, "read the questions")),
        );
    };
    read();
    const stop = follow(client.subscribe(QuestionsPort, "changed"), read);
    return () => {
      active = false;
      stop();
    };
  }, [client]);
  return { chats, problem };
}

/**
 * A chat's questions answered from the dashboard, through the chat's own methods: the chat is opened for each call, as
 * a tab would open it, and let go after, so the answer takes the path and the checks it takes inside the chat.
 */
function chatAnswerer(client: AppClient, threadId: ThreadId): QuestionAnswerer {
  const session = client.port(ChatSessionPort);
  const inChat = async (method: string, params: unknown): Promise<unknown> => {
    await session.open({ threadId });
    try {
      return await session.request({ threadId, method, params });
    } finally {
      await session.close({ threadId }).catch(() => undefined);
    }
  };
  return {
    answerQuestion: async (id, answer) =>
      ((await inChat("answer_question", { id, ...answer })) as { record: QuestionRecord }).record,
    skipQuestion: async (id) =>
      ((await inChat("skip_question", { id })) as { record: QuestionRecord }).record,
    sendAnswers: async () =>
      ((await inChat("send_answers", {})) as { records: readonly QuestionRecord[] }).records,
  };
}

const folderName = (folder: string | null): string | null =>
  folder === null ? null : (folder.split("/").filter(Boolean).at(-1) ?? folder);

/**
 * The questions that wait for you in every chat, each chat's under its name: omp's questions that stop the chat until
 * you answer, as above the chat's message box, and those its agent asked without waiting (`ask_async`), as in the chat's
 * own Questions panel. Answered here, a question leaves once its answer went to the chat; Open chat goes to it.
 */
export function QuestionsSection({
  client,
  onOpenChat,
}: {
  readonly client: AppClient;
  readonly onOpenChat?: (target: ChatTarget) => void;
}): ReactNode {
  const { chats, problem } = useOpenQuestions(client);
  const session = useMemo(() => client.port(ChatSessionPort), [client]);
  const answerers = useMemo(() => new Map<ThreadId, QuestionAnswerer>(), []);
  const answererOf = (threadId: ThreadId): QuestionAnswerer => {
    const known = answerers.get(threadId);
    if (known !== undefined) return known;
    const made = chatAnswerer(client, threadId);
    answerers.set(threadId, made);
    return made;
  };
  return (
    <div className="flex flex-col gap-4">
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      {chats !== null && chats.length === 0 && (
        <p className="text-sm text-t3">
          No question waits for you. When a chat's agent asks something it does not need at once, or
          omp stops a chat to ask you, the question shows here and in that chat, and waits for you.
        </p>
      )}
      {(chats ?? []).map((chat) => {
        const name = chat.title ?? "A new chat";
        const where = folderName(chat.folder);
        return (
          <section
            key={chat.threadId}
            aria-label={`Questions from ${name}`}
            className="flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h4 className="min-w-0 truncate text-sm font-medium text-t1">{name}</h4>
              {where !== null && <span className="text-xs text-t3">in {where}</span>}
              {onOpenChat !== undefined && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto max-sm:h-11"
                  onClick={() =>
                    onOpenChat({
                      kind: "existing",
                      threadId: chat.threadId,
                      sessionFile: null,
                      ...(chat.folder === null ? {} : { folder: chat.folder }),
                    })
                  }
                >
                  Open chat
                </Button>
              )}
            </div>
            {chat.requests.filter(isOmpQuestion).map((request) => (
              <OmpQuestionCard
                key={request.id}
                request={request}
                answerWith={(answer) =>
                  session.answer({ threadId: chat.threadId, id: request.id, answer })
                }
              />
            ))}
            {chat.records.length > 0 && (
              <WaitingQuestions records={chat.records} controller={answererOf(chat.threadId)} />
            )}
          </section>
        );
      })}
    </div>
  );
}
