import type { FolderPath, SessionFile, ThreadId } from "@omp-app/contracts";
import { cn } from "cn";
import {
  Ellipsis,
  PanelRight,
  PencilLine,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatTarget } from "../chat/controller";
import { InboxButton } from "../inbox/InboxButton";
import { KEYS, keycap } from "../keys/table";
import { togglePanel, usePanelState } from "../panels/panel-state";
import { ThemeSwitch } from "../theme/ThemeSwitch";
import { WhatsNew } from "../tour/WhatsNew";
import type { WorkspaceHandle, WorkspaceView } from "../workspace/Workspace";
import type { ChatList } from "./useChatList";

/** How long the pointer rests on a chat before it is read ahead. */
const PREFETCH_REST_MS = 120;

type ChatState = "waiting" | "running" | null;

const titleOf = (session: SessionFile): string =>
  session.displayTitle ?? session.title ?? session.firstPrompt ?? "Untitled chat";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Row buttons that show on hover or focus (always on a touch screen). */
const REVEAL =
  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * The chosen folder's chats: those waiting for you first, then pinned ones, then the rest, newest first. Each row has
 * its state (running, waiting for you) and whether it is open in a pane; search narrows every list. A click opens a
 * chat in the focused pane, Alt+click beside it. Each row's menu renames or deletes its chat.
 */
export function Sidebar({
  folderMenu,
  folder,
  list,
  view,
  hidden,
  onOpen,
  onPrefetch,
  onDeleted,
  onSettings,
  workspace,
}: {
  /** The folder at the top, with its menu to switch it. */
  readonly folderMenu: ReactNode;
  readonly folder: FolderPath;
  readonly list: ChatList;
  readonly view: WorkspaceView;
  /** On a phone while a chat is shown. */
  readonly hidden: boolean;
  readonly onOpen: (target: ChatTarget, where: "here" | "split") => void;
  /** The pointer rests on a chat: read it ahead, so opening it shows it at once. */
  readonly onPrefetch: (session: SessionFile) => void;
  /** A chat was deleted: the panes that showed it move on. */
  readonly onDeleted: (id: ThreadId) => void;
  readonly onSettings: () => void;
  /** For the What's new card, which starts a tour in the workspace. */
  readonly workspace: RefObject<WorkspaceHandle | null>;
}): ReactNode {
  const [query, setQuery] = useState("");
  const sidePanelOpen = usePanelState().open;
  const [problem, setProblem] = useState<string | null>(null);
  /** Titles typed into a rename that omp has not saved yet. */
  const [renamed, setRenamed] = useState<ReadonlyMap<ThreadId, string>>(new Map());
  /** The chat the delete dialog asks about; kept while the dialog closes, so its words stay put. */
  const [deleting, setDeleting] = useState<SessionFile | null>(null);
  const [confirming, setConfirming] = useState(false);
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
  const rename = (session: SessionFile, typed: string): void => {
    const name = typed.trim();
    if (name === "" || name === titleOf(session)) return;
    setProblem(null);
    setRenamed((current) => new Map(current).set(session.id, name));
    list
      .rename(session.id, name)
      .catch((failure: unknown) => setProblem(`Could not rename it: ${errorText(failure)}`))
      .finally(() =>
        setRenamed((current) => {
          const next = new Map(current);
          next.delete(session.id);
          return next;
        }),
      );
  };
  const remove = (session: SessionFile): void => {
    setConfirming(false);
    setProblem(null);
    list
      .remove(session)
      .then(() => onDeleted(session.id))
      .catch((failure: unknown) => setProblem(`Could not delete it: ${errorText(failure)}`));
  };
  const row = (session: SessionFile): ReactNode => (
    <ChatRow
      key={session.id}
      title={renamed.get(session.id) ?? titleOf(session)}
      saving={renamed.has(session.id)}
      state={stateOf(session.id)}
      open={view.open.has(session.id)}
      focused={view.focused === session.id}
      pinned={list.pinned.has(session.id)}
      onOpen={(where) =>
        onOpen({ kind: "existing", threadId: session.id, sessionFile: session.sessionFile }, where)
      }
      onPrefetch={() => onPrefetch(session)}
      onPin={() => {
        setProblem(null);
        list
          .setPinned(session.id, !list.pinned.has(session.id))
          .catch((failure: unknown) =>
            setProblem(`Could not change the pin: ${errorText(failure)}`),
          );
      }}
      onRename={(typed) => rename(session, typed)}
      onDelete={() => {
        setDeleting(session);
        setConfirming(true);
      }}
    />
  );
  return (
    <nav aria-label="Chats" className={cn("flex min-h-0 flex-col p-2", hidden && "hidden")}>
      {folderMenu}
      <Button
        data-tour="new-chat"
        variant="ghost"
        className="justify-start gap-2 px-2 text-t2 hover:text-t1"
        onClick={() => onOpen({ kind: "new", folder }, "here")}
      >
        <SquarePen />
        New chat
      </Button>
      <label
        data-tour="search-chats"
        className="mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-t3 focus-within:bg-l1"
      >
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
      <div data-tour="chat-list" className="min-h-0 flex-1 overflow-y-auto">
        {waiting.length > 0 && <Section label="Needs you">{waiting.map(row)}</Section>}
        {pinned.length > 0 && <Section label="Pinned">{pinned.map(row)}</Section>}
        <Section label="Chats">{rest.map(row)}</Section>
        {needle !== "" && shown.length === 0 && (
          <p className="px-2 py-1 text-xs text-t3">No chat's title has "{query.trim()}".</p>
        )}
      </div>
      {problem !== null && (
        <p role="alert" className="px-2 py-1 text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <WhatsNew workspace={workspace} />
      <div className="flex items-center justify-between px-1 pt-2">
        <ThemeSwitch />
        <div className="flex items-center gap-0.5">
          <InboxButton onOpenChat={(target) => onOpen(target, "here")} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-tour="side-panel-button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Side panel"
                  aria-pressed={sidePanelOpen}
                  aria-keyshortcuts="Control+Alt+B"
                  className="text-t3 hover:text-t1 aria-pressed:text-t1"
                  onClick={togglePanel}
                />
              }
            >
              <PanelRight />
            </TooltipTrigger>
            <TooltipContent side="top">Side panel · {keycap(KEYS.sidePanel)}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-tour="settings"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Settings"
                  aria-keyshortcuts="Control+,"
                  className="text-t3 hover:text-t1"
                  onClick={onSettings}
                />
              }
            >
              <Settings />
            </TooltipTrigger>
            <TooltipContent side="top">Settings · {keycap(KEYS.settings)}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting === null ? "" : titleOf(deleting)}” and its files are deleted. This can't
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting !== null) remove(deleting);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  saving,
  open,
  focused,
  pinned,
  onOpen,
  onPrefetch,
  onPin,
  onRename,
  onDelete,
}: {
  readonly title: string;
  readonly state: ChatState;
  /** A new title is on its way to omp: shown already, muted until omp has saved it. */
  readonly saving: boolean;
  readonly open: boolean;
  readonly focused: boolean;
  readonly pinned: boolean;
  readonly onOpen: (where: "here" | "split") => void;
  readonly onPrefetch: () => void;
  readonly onPin: () => void;
  readonly onRename: (typed: string) => void;
  readonly onDelete: () => void;
}): ReactNode {
  // A pointer passing over the list reads nothing; one that rests on a row a moment reads that chat ahead.
  const resting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  /** Rename was chosen in the menu: the closing menu leaves the caret in the title field. */
  const renaming = useRef(false);
  /** The rename ended with Enter or Esc: the caret goes back to the row. */
  const refocus = useRef(false);
  const titleButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    titleButton.current?.focus();
  }, [editing]);
  const said = [
    title,
    state === "waiting" ? "waiting for you" : state === "running" ? "running" : null,
    open ? "open in a pane" : null,
  ].filter((part) => part !== null);
  return (
    <li
      className="group/row flex items-center rounded-md hover:bg-l1 has-[[aria-current=true]]:bg-l2"
      onPointerEnter={() => {
        resting.current = setTimeout(onPrefetch, PREFETCH_REST_MS);
      }}
      onPointerLeave={() => clearTimeout(resting.current)}
    >
      {editing ? (
        <RenameField
          title={title}
          onDone={(typed, byKey) => {
            renaming.current = false;
            refocus.current = byKey;
            setEditing(false);
            if (typed !== null) onRename(typed);
          }}
        />
      ) : (
        <button
          ref={titleButton}
          type="button"
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-t2 outline-none group-hover/row:text-t1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-busy:text-t3 aria-[current=true]:text-t1 max-sm:h-11"
          aria-current={focused ? "true" : undefined}
          aria-busy={saving ? "true" : undefined}
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
      )}
      {!editing && (
        <>
          <button
            type="button"
            // In the row of its chat; the chat's title stays the name of the row's own button.
            aria-label={pinned ? "Unpin" : "Pin"}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-sm text-t3 hover:bg-l2 hover:text-t1",
              REVEAL,
            )}
            onClick={onPin}
          >
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="More"
              className={cn(
                "mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-t3 outline-none hover:bg-l2 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-l2 data-popup-open:text-t1 data-popup-open:opacity-100",
                REVEAL,
              )}
            >
              <Ellipsis className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-auto" finalFocus={() => !renaming.current}>
              <DropdownMenuItem
                onClick={() => {
                  renaming.current = true;
                  setEditing(true);
                }}
              >
                <PencilLine />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </li>
  );
}

/**
 * A chat's title, being renamed in its row. Enter or leaving the field saves it; Esc leaves it as it was. `byKey` says
 * the field ended from the keyboard, so the caret goes back to the row rather than staying wherever a click put it.
 */
function RenameField({
  title,
  onDone,
}: {
  readonly title: string;
  readonly onDone: (typed: string | null, byKey: boolean) => void;
}): ReactNode {
  const done = useRef(false);
  const finish = (typed: string | null, byKey: boolean): void => {
    if (done.current) return;
    done.current = true;
    onDone(typed, byKey);
  };
  return (
    <input
      aria-label="Chat title"
      defaultValue={title}
      // biome-ignore lint/a11y/noAutofocus: the field opens because Rename was chosen, so typing goes into it
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null, true);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value, false)}
      // The title stays where the row draws it (after the state dot), and the row keeps its height.
      className="h-8 min-w-0 flex-1 rounded-md bg-l1 pr-2 pl-[22px] text-[0.8125rem] text-t1 outline-none ring-1 ring-ring ring-inset max-sm:h-11"
    />
  );
}
