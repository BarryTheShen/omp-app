import { cn } from "cn";
import { Bell } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { ChatTarget } from "../chat/controller";
import { type InboxEntry, inbox, setInboxOpen, useInbox, useInboxOpen } from "./inbox";

/** Each row's state, in omp's words where omp has them ("Stopped with error" is its desktop notification's). */
const SAID: Record<InboxEntry["state"], string> = {
  waiting: "Waiting for you",
  done: "Done",
  error: "Stopped with error",
  crashed: "omp quit unexpectedly",
  unstarted: "omp could not start",
};

const DOT: Record<InboxEntry["state"], string> = {
  waiting: "bg-warn",
  done: "bg-ok",
  error: "bg-bad",
  crashed: "bg-bad",
  unstarted: "bg-bad",
};

const time = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The bell in the sidebar, with how many chats need a look, and the inbox it opens (Tern's): the chats waiting for
 * you, then what runs settled with while you were elsewhere. A row takes you to its chat; Clear empties the settled
 * rows.
 */
export function InboxButton({
  onOpenChat,
}: {
  /** Goes to a chat: its pane where it is open, else it opens in the focused pane. */
  readonly onOpenChat: (target: ChatTarget) => void;
}): ReactNode {
  const entries = useInbox();
  const open = useInboxOpen();
  const waiting = entries.some((entry) => entry.state === "waiting");
  const settled = entries.some((entry) => entry.state !== "waiting");
  const go = (entry: InboxEntry): void => {
    setInboxOpen(false);
    onOpenChat({ kind: "existing", threadId: entry.threadId, sessionFile: entry.sessionFile });
  };
  return (
    <Popover open={open} onOpenChange={setInboxOpen}>
      <PopoverTrigger
        render={
          <Button
            data-tour="inbox-button"
            variant="ghost"
            size="icon-sm"
            aria-label={entries.length === 0 ? "Inbox" : `Inbox: ${entries.length}`}
            className={cn(
              "relative text-t3 hover:text-t1 data-popup-open:text-t1",
              waiting && "text-warn-ink",
            )}
          />
        }
      >
        <Bell />
        {entries.length > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-0.5 text-[0.625rem] leading-none font-medium text-accent-foreground tabular-nums"
          >
            {entries.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent data-tour="inbox" side="top" align="start" className="w-80 gap-1 p-1.5">
        <div className="flex items-center justify-between gap-2 py-0.5 pr-0.5 pl-1.5">
          <PopoverTitle className="text-sm text-t1">Inbox</PopoverTitle>
          <Button variant="ghost" size="sm" disabled={!settled} onClick={() => inbox.clear()}>
            Clear
          </Button>
        </div>
        {entries.length === 0 ? (
          <p className="px-1.5 pt-1 pb-2 text-sm text-t3">Nothing needs you.</p>
        ) : (
          <ul
            aria-label="Chats that need a look"
            className="flex max-h-96 flex-col overflow-y-auto"
          >
            {entries.map((entry) => (
              <li key={entry.threadId + entry.state}>
                <button
                  type="button"
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-l2 focus-visible:bg-l2 focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => go(entry)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", DOT[entry.state])}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-t1">{entry.title}</span>
                    <span className="shrink-0 text-xs text-t3 tabular-nums">{time(entry.at)}</span>
                  </span>
                  <span className="pl-3.5 text-xs text-t2">{SAID[entry.state]}</span>
                  {entry.reason !== "" && (
                    <span className="line-clamp-2 pl-3.5 text-xs break-words text-t3">
                      {entry.reason}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
