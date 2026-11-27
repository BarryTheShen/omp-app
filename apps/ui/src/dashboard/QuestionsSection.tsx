import type { AppClient } from "@omp-app/client";
import {
  ChatSessionPort,
  type OpenQuestionsChat,
  OpenQuestionsList,
  QuestionsPort,
} from "@omp-app/contracts";
import { isOmpQuestion } from "@omp-app/contracts/chat-host";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatTarget } from "../chat/controller";
import { OmpQuestionCard } from "../chat/HostRequests";
import { follow } from "../follow";
import { lastSeen } from "../lastSeen";
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

const folderName = (folder: string | null): string | null =>
  folder === null ? null : (folder.split("/").filter(Boolean).at(-1) ?? folder);

/**
 * omp's questions that stop a chat until you answer, in every chat, each chat's under its name, as above the chat's
 * message box. Answered here, a question leaves once omp has its answer; Open chat goes to it. Questions asked in
 * threads are in the Workbench beside this.
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
  return (
    <div className="flex flex-col gap-4">
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      {chats !== null && chats.length === 0 && (
        <p className="text-sm text-t3">
          No chat is stopped waiting for you. When omp stops a chat to ask you, the question shows
          here and above the chat's message box.
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
          </section>
        );
      })}
    </div>
  );
}
