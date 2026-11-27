import type { AppClient } from "@omp-app/client";
import type { ThreadId, WorkThreadId, WorkThreadSummary } from "@omp-app/contracts";
import { type ReactNode, useState } from "react";
import type { ChatTarget } from "../../chat/controller";
import { TabButton } from "../btw/BtwPanel";
import { FILTERS, type Filter, filtered, tabName, useWorkThreadList } from "./threads";
import { ThreadRow, ThreadView } from "./WorkbenchPanel";

/** A chat's group in the list: its id, its name, and its threads in the list's order. */
interface ChatGroup {
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly threads: readonly WorkThreadSummary[];
}

const ALL = "all";

/**
 * Every chat's Workbench on the dashboard: on the left the threads of every chat, under each chat's name, with the
 * side panel's tabs and a chat to narrow it to; on the right the thread picked, as large as the page allows. A narrow
 * page shows one at a time: the list, then the thread with Threads to go back.
 */
export function DashboardWorkbench({
  client,
  onOpenChat,
}: {
  readonly client: AppClient;
  readonly onOpenChat?: (target: ChatTarget) => void;
}): ReactNode {
  const { list, missing } = useWorkThreadList(client);
  const [filter, setFilter] = useState<Filter>("Open");
  const [chat, setChat] = useState<string>(ALL);
  const [picked, setPicked] = useState<WorkThreadId | null>(null);
  if (missing) return <p className="text-sm text-t3">This server has no Workbench yet.</p>;
  if (list === null) return <p className="text-sm text-t3">Reading the threads…</p>;

  const names = new Map((list.chats ?? []).map((one) => [one.threadId as string, one.title]));
  const nameOf = (owner: ThreadId | null): string =>
    owner === null ? "No chat" : (names.get(owner) ?? "A chat");
  const mine = list.threads.filter((thread) => chat === ALL || thread.owner === chat);
  const groups: ChatGroup[] = [];
  for (const thread of filtered(mine, filter)) {
    const group = groups.find((one) => one.threadId === thread.owner);
    if (group === undefined)
      groups.push({ threadId: thread.owner, title: nameOf(thread.owner), threads: [thread] });
    else (group.threads as WorkThreadSummary[]).push(thread);
  }
  const owners = [
    ...new Set(list.threads.flatMap((thread) => (thread.owner === null ? [] : [thread.owner]))),
  ];
  const shownPicked = picked !== null && list.threads.some((thread) => thread.id === picked);

  return (
    <div
      data-tour="dashboard-workbench"
      className="grid min-h-[28rem] gap-3 @4xl:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]"
    >
      <section
        className={`min-w-0 flex-col gap-2 ${shownPicked ? "hidden @4xl:flex" : "flex"}`}
        aria-label="Every chat's threads"
      >
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Threads" className="row-scroll flex gap-1">
            {FILTERS.map((name) => (
              <TabButton key={name} selected={filter === name} onClick={() => setFilter(name)}>
                {tabName(name, mine)}
              </TabButton>
            ))}
          </div>
          <select
            aria-label="Chat"
            // As wide as its column at most: a chat's name can be its whole first message.
            className="w-48 min-w-0 max-w-full truncate rounded-md border border-l2 bg-l1 px-1.5 py-1 text-xs text-t1"
            value={chat}
            onChange={(event) => setChat(event.target.value)}
          >
            <option value={ALL}>Every chat</option>
            {owners.map((owner) => (
              <option key={owner} value={owner}>
                {nameOf(owner)}
              </option>
            ))}
          </select>
        </div>
        {groups.length === 0 ? (
          <p className="px-1 py-2 text-sm text-t3">
            {filter === "Open" ? "No open threads." : "No closed threads."}
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.threadId ?? "none"}
              aria-label={`Threads of ${group.title}`}
              className="flex flex-col gap-1"
            >
              <div className="flex items-center gap-2 px-1">
                <h4 className="min-w-0 flex-1 truncate text-xs font-medium text-t2">
                  {group.title}
                </h4>
                {group.threadId !== null && onOpenChat !== undefined && (
                  <button
                    type="button"
                    className="text-xs text-accent-ink underline"
                    onClick={() =>
                      onOpenChat({
                        kind: "existing",
                        threadId: group.threadId as ThreadId,
                        sessionFile: null,
                      })
                    }
                  >
                    Open chat
                  </button>
                )}
              </div>
              <ul className="flex flex-col gap-1">
                {group.threads.map((thread) => (
                  <li
                    key={thread.id}
                    className={thread.id === picked ? "rounded-md bg-l1" : undefined}
                  >
                    <ThreadRow thread={thread} onOpen={() => setPicked(thread.id)} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
      <div
        className={`min-h-[28rem] min-w-0 rounded-lg border border-l2 ${shownPicked ? "flex" : "hidden @4xl:flex"} flex-col`}
      >
        {shownPicked && picked !== null ? (
          <ThreadView
            key={picked}
            client={client}
            id={picked}
            chat={null}
            {...(onOpenChat === undefined ? {} : { openChat: onOpenChat })}
            onBack={() => setPicked(null)}
          />
        ) : (
          <p className="m-auto px-4 text-sm text-t3">Pick a thread to read it here.</p>
        )}
      </div>
    </div>
  );
}
