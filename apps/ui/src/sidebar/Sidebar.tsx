import type { FolderPath, SessionFile, ThreadId } from "@omp-app/contracts";
import { cn } from "cn";
import { Pin, PinOff, Search, SquarePen } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatTarget } from "../chat/controller";
import { ThemeSwitch } from "../theme/ThemeSwitch";
import type { WorkspaceView } from "../workspace/Workspace";
import type { ChatList } from "./useChatList";

type ChatState = "waiting" | "running" | null;

const titleOf = (session: SessionFile): string =>
  session.displayTitle ?? session.title ?? session.firstPrompt ?? "Untitled chat";

/**
 * The launch folder's chats: those waiting for you first, then pinned ones, then the rest, newest first. Each row has
 * its state (running, waiting for you) and whether it is open in a pane; search narrows every list. A click opens a
 * chat in the focused pane, Alt+click beside it.
 */
export function Sidebar({
  folder,
  list,
  view,
  hidden,
  onOpen,
}: {
  readonly folder: FolderPath;
  readonly list: ChatList;
  readonly view: WorkspaceView;
  /** On a phone while a chat is shown. */
  readonly hidden: boolean;
  readonly onOpen: (target: ChatTarget, where: "here" | "split") => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = list.sessions.filter(
    (session) => needle === "" || titleOf(session).toLowerCase().includes(needle),
  );
  const waiting = shown.filter((session) => view.waiting.has(session.id));
  const pinned = shown.filter(
    (session) => list.pinned.has(session.id) && !view.waiting.has(session.id),
  );
  const rest = shown.filter(
    (session) => !list.pinned.has(session.id) && !view.waiting.has(session.id),
  );
  const stateOf = (id: ThreadId): ChatState =>
    view.waiting.has(id) ? "waiting" : list.running.has(id) ? "running" : null;
  const row = (session: SessionFile): ReactNode => (
    <ChatRow
      key={session.id}
      title={titleOf(session)}
      state={stateOf(session.id)}
      open={view.open.has(session.id)}
      focused={view.focused === session.id}
      pinned={list.pinned.has(session.id)}
      onOpen={(where) =>
        onOpen({ kind: "existing", threadId: session.id, sessionFile: session.sessionFile }, where)
      }
      onPin={() => {
        setPinError(null);
        list
          .setPinned(session.id, !list.pinned.has(session.id))
          .catch((failure: unknown) =>
            setPinError(
              `Could not change the pin: ${failure instanceof Error ? failure.message : String(failure)}`,
            ),
          );
      }}
    />
  );
  return (
    <nav aria-label="Chats" className={cn("flex min-h-0 flex-col p-2", hidden && "hidden")}>
      <Button
        variant="ghost"
        className="justify-start gap-2 px-2 text-t2 hover:text-t1"
        onClick={() => onOpen({ kind: "new", folder }, "here")}
      >
        <SquarePen />
        New chat
      </Button>
      <label className="mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-t3 focus-within:bg-l1">
        <Search className="size-3.5 shrink-0" />
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search"
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-t1 outline-none placeholder:text-t3"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {waiting.length > 0 && <Section label="Needs you">{waiting.map(row)}</Section>}
        {pinned.length > 0 && <Section label="Pinned">{pinned.map(row)}</Section>}
        <Section label="Chats">{rest.map(row)}</Section>
        {needle !== "" && shown.length === 0 && (
          <p className="px-2 py-1 text-xs text-t3">No chat's title has "{query.trim()}".</p>
        )}
      </div>
      {pinError !== null && (
        <p role="alert" className="px-2 py-1 text-xs text-bad-ink">
          {pinError}
        </p>
      )}
      <div className="flex px-1 pt-2">
        <ThemeSwitch />
      </div>
    </nav>
  );
}

function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section aria-label={label}>
      <h2 className="px-2 pt-4 pb-1 text-xs font-medium text-t3">{label}</h2>
      <ul>{children}</ul>
    </section>
  );
}

function ChatRow({
  title,
  state,
  open,
  focused,
  pinned,
  onOpen,
  onPin,
}: {
  readonly title: string;
  readonly state: ChatState;
  readonly open: boolean;
  readonly focused: boolean;
  readonly pinned: boolean;
  readonly onOpen: (where: "here" | "split") => void;
  readonly onPin: () => void;
}): ReactNode {
  const said = [
    title,
    state === "waiting" ? "waiting for you" : state === "running" ? "running" : null,
    open ? "open in a pane" : null,
  ].filter((part) => part !== null);
  return (
    <li className="group/row flex items-center rounded-md hover:bg-l1 has-[[aria-current=true]]:bg-l2">
      <button
        type="button"
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-t2 outline-none group-hover/row:text-t1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:text-t1 max-sm:h-11"
        aria-current={focused ? "true" : undefined}
        // One phrase for a screen reader: the title, its state, and whether a pane shows it.
        aria-label={said.join(", ")}
        onClick={(event) => onOpen(event.altKey ? "split" : "here")}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            state === "waiting" && "bg-warn",
            state === "running" && "bg-live",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {open && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-t3" />}
      </button>
      <button
        type="button"
        // In the row of its chat; the chat's title stays the name of the row's own button.
        aria-label={pinned ? "Unpin" : "Pin"}
        className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-t3 opacity-0 group-hover/row:opacity-100 hover:bg-l2 hover:text-t1 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={onPin}
      >
        {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      </button>
    </li>
  );
}
