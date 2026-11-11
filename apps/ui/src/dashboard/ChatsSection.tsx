import type { AppClient } from "@omp-app/client";
import {
  ChatSessionPort,
  type RunningChat,
  type ThreadId,
  UsageLimitStore,
  type UsageSharesResult,
} from "@omp-app/contracts";
import { Pause, Play } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatTarget } from "../chat/controller";
import { follow } from "../follow";
import { partWords, spendWords } from "../panels/usage/usage-words";
import { STATE_DOT } from "./palette";
import { problemWords } from "./problems";

const LATER = "The chats' models come with the next server update.";

const STATE_WORDS: Record<RunningChat["state"], string> = {
  working: "Working",
  waiting: "Waits for you",
  paused: "Paused",
  idle: "Idle",
};

/** Each running chat's model, read again as the running chats change. */
function useModels(
  client: AppClient,
  running: readonly RunningChat[],
): ReadonlyMap<ThreadId, { readonly name: string; readonly provider: string }> {
  const [models, setModels] = useState<
    ReadonlyMap<ThreadId, { readonly name: string; readonly provider: string }>
  >(new Map());
  const ids = running.map((chat) => chat.threadId).join(" ");
  useEffect(() => {
    if (ids === "") return;
    let alive = true;
    client
      .port(ChatSessionPort)
      .runningModels({})
      .then(
        (read) =>
          alive &&
          setModels(
            new Map(
              read.chats.map((chat) => [
                chat.threadId,
                { name: chat.name, provider: chat.provider },
              ]),
            ),
          ),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [client, ids]);
  return models;
}

/** Each provider's 5-hour window split among the chats, read again at each fresh reading of the limits. */
export function useShares(client: AppClient): UsageSharesResult | null {
  const [shares, setShares] = useState<UsageSharesResult | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      client
        .port(ChatSessionPort)
        .usageShares({})
        .then(
          (found) => alive && setShares(found),
          () => undefined,
        );
    };
    read();
    const stop = follow(client.subscribe(UsageLimitStore, "changed"), read);
    return () => {
      alive = false;
      stop();
    };
  }, [client]);
  return shares;
}

/**
 * Every chat running now (#15): what it does, the model it answers with, its part of its provider's 5-hour window and
 * what it spent there; open it, or pause and continue it, as `/pause` does, from here.
 */
export function ChatsSection({
  client,
  running,
  onOpenChat,
}: {
  readonly client: AppClient;
  readonly running: readonly RunningChat[];
  readonly onOpenChat?: (target: ChatTarget) => void;
}): ReactNode {
  const models = useModels(client, running);
  const shares = useShares(client);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<ThreadId | null>(null);

  /** Pauses or continues a chat through its own requests: opened for the call, as a tab opens it, and let go after. */
  const hold = (threadId: ThreadId, method: "pause" | "resume"): void => {
    const session = client.port(ChatSessionPort);
    setBusy(threadId);
    setProblem(null);
    void (async () => {
      try {
        await session.open({ threadId });
        try {
          await session.request({ threadId, method, params: {} });
        } finally {
          await session.close({ threadId }).catch(() => undefined);
        }
      } catch (failure) {
        setProblem(problemWords(failure, LATER, method === "pause" ? "pause it" : "continue it"));
      } finally {
        setBusy(null);
      }
    })();
  };

  if (running.length === 0) {
    return <p className="text-[0.8125rem] text-t3">No chat is running now.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Running chats" className="flex flex-col">
        {running.map((chat) => {
          const model = models.get(chat.threadId);
          const window =
            model === undefined
              ? undefined
              : shares?.providers.find((each) => each.providerId === model.provider);
          const part = window?.chats.find((each) => each.threadId === chat.threadId);
          const name = chat.title ?? "New chat";
          return (
            <li
              key={chat.threadId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-l2 py-2 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 basis-56 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${STATE_DOT[chat.state]}`}
                  />
                  <span className="truncate text-[0.8125rem] font-medium text-t1">{name}</span>
                </span>
                <span className="truncate pl-4 text-xs text-t3">
                  {STATE_WORDS[chat.state]}
                  {model === undefined ? "" : ` · ${model.name}`}
                  {part === undefined
                    ? ""
                    : ` · ${partWords(part.share)} of ${model?.provider ?? ""}'s 5-hour window, ${spendWords(part.cost)}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {chat.state === "paused" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-sm:h-11"
                    aria-label={`Continue ${name}`}
                    disabled={busy === chat.threadId}
                    onClick={() => hold(chat.threadId, "resume")}
                  >
                    <Play />
                    Continue
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-sm:h-11"
                    aria-label={`Pause ${name}`}
                    disabled={busy === chat.threadId}
                    onClick={() => hold(chat.threadId, "pause")}
                  >
                    <Pause />
                    Pause
                  </Button>
                )}
                {onOpenChat !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-sm:h-11"
                    aria-label={`Open ${name}`}
                    onClick={() =>
                      onOpenChat({
                        kind: "existing",
                        threadId: chat.threadId,
                        sessionFile: chat.sessionFile,
                        folder: chat.folder,
                      })
                    }
                  >
                    Open
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
    </div>
  );
}
