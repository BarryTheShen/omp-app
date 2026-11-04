import type {
  FolderPath,
  RunningChat,
  RunningChatState,
  RunningSession,
  SessionFile,
  ThreadId,
} from "@omp-app/contracts";
import { cn } from "cn";
import {
  CircleStop,
  Clock,
  Ellipsis,
  PanelLeftClose,
  Pause,
  PencilLine,
  Pin,
  PinOff,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  SquarePlus,
  Trash2,
} from "lucide-react";
import {
  type DragEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { firstPromptOf } from "../chat/firstPrompts";
import { folderName } from "../folders/folder";
import { InboxButton } from "../inbox/InboxButton";
import { isImeEnter } from "../keys/ime";
import { KEYS, keycap } from "../keys/table";
import { useLongPress } from "../longPress";
import { useSwipe } from "../swipe";
import { ThemeSwitch } from "../theme/ThemeSwitch";
import { WhatsNew } from "../tour/WhatsNew";
import { startChatDrag } from "../workspace/chatDrag";
import type { WorkspaceHandle, WorkspaceView } from "../workspace/Workspace";
import { titleOf } from "./title";
import type { ChatList } from "./useChatList";

/** How long the pointer rests on a chat before it is read ahead. */
const PREFETCH_REST_MS = 120;

/**
 * What a row's mark says: omp waits for an answer, the chat is paused (omp's `/pause`), a turn runs, or the app continues
 * the chat once its usage limit resets (#2781).
 */
type ChatState = "waiting" | "paused" | "running" | "continuing" | null;

/** A running chat's state as its row's mark (D1): idle has none. */
const RUNNING_MARK: Readonly<Record<RunningChatState, ChatState>> = {
  working: "running",
  waiting: "waiting",
  paused: "paused",
  idle: null,
};

/** A chat whose first reply still runs has no file to title it yet: the first message this page sent in it names it. */
const startingTitleOf = (id: ThreadId): string => firstPromptOf(id) ?? "New chat";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Row buttons that show on hover or focus (always on a touch screen). */
const REVEAL =
  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * The chosen folder's chats: those waiting for you first, then pinned ones, then the rest, newest first. Each row has
 * its state (running, waiting for you) and whether a window shows it; search narrows every list. A click opens a
 * chat in the focused window, Alt+click beside it. Each row's menu renames or deletes its chat. A chat whose first reply
 * still runs has its row before omp has written its file, at the top, with no pin or menu until that file comes. Above
 * them, the chats that run in other folders (D1), each with its folder's name: this folder's are in the list already.
 */
export function Sidebar({
  folderMenu,
  folder,
  home,
  list,
  running,
  view,
  hidden,
  onOpen,
  onPrefetch,
  onDeleted,
  onStopRunning,
  onSettings,
  onWhatsNew,
  workspace,
  phone,
  connection,
  edge,
  onHide,
}: {
  /** The folder at the top, with its menu to switch it. */
  readonly folderMenu: ReactNode;
  readonly folder: FolderPath;
  /** The home folder on the server's computer, named `~` in a running chat's row; null while it is not known. */
  readonly home: FolderPath | null;
  readonly list: ChatList;
  /** The chats that run on the server now, from every folder (D1). */
  readonly running: readonly RunningChat[];
  readonly view: WorkspaceView;
  /** On a phone while a chat is shown; on a desktop while the list is hidden (#2805). */
  readonly hidden: boolean;
  readonly onOpen: (target: ChatTarget, where: "here" | "split") => void;
  /** The pointer rests on a chat: read it ahead, so opening it shows it at once. */
  readonly onPrefetch: (session: SessionFile) => void;
  /** A chat was deleted: the panes that showed it move on. */
  readonly onDeleted: (id: ThreadId) => void;
  /** Ends a running chat's process (D1); refused with the reason when another tab has it open. */
  readonly onStopRunning: (id: ThreadId) => Promise<void>;
  readonly onSettings: () => void;
  /** Opens the What's new list: every update and its tours. */
  readonly onWhatsNew: () => void;
  /** For the What's new card, which starts a tour in the workspace. */
  readonly workspace: RefObject<WorkspaceHandle | null>;
  /** On a phone, where the side panel has no rail at the window's edge, its button sits here. */
  readonly phone: boolean;
  /** The link to the app's server, in the foot beside Settings (#2789). */
  readonly connection: ReactNode;
  /** On a desktop, the list's right edge, which resizes it (#2805). */
  readonly edge?: ReactNode;
  /** On a desktop, hides the list (#2805); Ctrl+B does too. */
  readonly onHide?: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  /** Titles typed into a rename that omp has not saved yet. */
  const [renamed, setRenamed] = useState<ReadonlyMap<ThreadId, string>>(new Map());
  /** The chat the delete dialog asks about; kept while the dialog closes, so its words stay put. */
  const [deleting, setDeleting] = useState<SessionFile | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** The running chat the stop dialog asks about, while its turn runs; kept while the dialog closes. */
  const [stopping, setStopping] = useState<{
    readonly id: ThreadId;
    readonly title: string;
  } | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  /** On a phone: the row swiped open, showing Pin and Delete; one at a time. */
  const [swiped, setSwiped] = useState<ThreadId | null>(null);
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
  const listed = new Set(list.sessions.map((session) => session.id));
  const starting = list.starting.filter(
    (chat) =>
      !listed.has(chat.id) &&
      (needle === "" || startingTitleOf(chat.id).toLowerCase().includes(needle)),
  );
  const runningTitleOf = (chat: RunningChat): string =>
    chat.title ?? startingTitleOf(chat.threadId);
  const elsewhere = running.filter(
    (chat) =>
      chat.folder !== folder &&
      (needle === "" || runningTitleOf(chat).toLowerCase().includes(needle)),
  );
  const stateOf = (id: ThreadId): ChatState =>
    view.waiting.has(id)
      ? "waiting"
      : list.paused.has(id)
        ? "paused"
        : list.running.has(id)
          ? "running"
          : list.continuing.has(id)
            ? "continuing"
            : null;
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
  const runningOf = new Map(running.map((chat) => [chat.threadId, chat]));
  const stopNow = (id: ThreadId): void => {
    setConfirmingStop(false);
    setProblem(null);
    onStopRunning(id).catch((failure: unknown) =>
      setProblem(`Could not stop it: ${errorText(failure)}`),
    );
  };
  /** A chat whose turn runs (or waits, or is paused) asks first: the stop ends that turn. An idle one stops at once. */
  const stop = (id: ThreadId, title: string): void => {
    if ((runningOf.get(id)?.state ?? "idle") === "idle") {
      stopNow(id);
      return;
    }
    setStopping({ id, title });
    setConfirmingStop(true);
  };
  /** Stop running, for a chat that runs on the server now. */
  const stopOf = (id: ThreadId, title: string): (() => void) | undefined =>
    runningOf.has(id) ? () => stop(id, title) : undefined;
  const row = (session: SessionFile): ReactNode => (
    <ChatRow
      key={session.id}
      title={renamed.get(session.id) ?? titleOf(session)}
      saving={renamed.has(session.id)}
      state={stateOf(session.id)}
      open={view.open.has(session.id)}
      focused={view.focused === session.id}
      onStop={stopOf(session.id, renamed.get(session.id) ?? titleOf(session))}
      target={{ kind: "existing", threadId: session.id, sessionFile: session.sessionFile }}
      onOpen={onOpen}
      phone={phone}
      swiped={swiped === session.id}
      onSwipe={(next) => setSwiped(next ? session.id : null)}
      actions={{
        pinned: list.pinned.has(session.id),
        onPrefetch: () => onPrefetch(session),
        onPin: () => {
          setProblem(null);
          list
            .setPinned(session.id, !list.pinned.has(session.id))
            .catch((failure: unknown) =>
              setProblem(`Could not change the pin: ${errorText(failure)}`),
            );
        },
        onRename: (typed) => rename(session, typed),
        onDelete: () => {
          setDeleting(session);
          setConfirming(true);
        },
      }}
    />
  );
  const startingRow = (chat: RunningSession): ReactNode => (
    <ChatRow
      key={chat.id}
      title={startingTitleOf(chat.id)}
      saving={false}
      state={stateOf(chat.id)}
      open={view.open.has(chat.id)}
      focused={view.focused === chat.id}
      target={{ kind: "existing", threadId: chat.id, sessionFile: null }}
      onOpen={onOpen}
      phone={phone}
    />
  );
  const runningRow = (chat: RunningChat): ReactNode => (
    <ChatRow
      key={chat.threadId}
      title={runningTitleOf(chat)}
      place={folderName(chat.folder, home)}
      saving={false}
      state={RUNNING_MARK[chat.state]}
      open={view.open.has(chat.threadId)}
      focused={view.focused === chat.threadId}
      // A chat stopped before omp has written its file would leave no chat behind: Stop waits for the file.
      onStop={
        chat.sessionFile === null ? undefined : () => stop(chat.threadId, runningTitleOf(chat))
      }
      target={{
        kind: "existing",
        threadId: chat.threadId,
        sessionFile: chat.sessionFile,
        folder: chat.folder,
      }}
      onOpen={onOpen}
      phone={phone}
    />
  );
  return (
    <nav
      aria-label="Chats"
      // On a short screen (a phone held sideways) the list keeps a few chats in view and the column scrolls to its foot.
      className={cn("relative flex min-h-0 flex-col p-2 short:overflow-y-auto", hidden && "hidden")}
      // A finger landing anywhere but on the open row shuts it, as a phone's lists do.
      onPointerDownCapture={(event) => {
        if (swiped === null) return;
        if (event.target instanceof Element && event.target.closest("[data-swiped='true']")) return;
        setSwiped(null);
      }}
    >
      {onHide === undefined ? (
        folderMenu
      ) : (
        <div className="flex items-center gap-0.5">
          <div className="min-w-0 flex-1">{folderMenu}</div>
          <Button
            data-tour="chat-list-hide"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-t3 hover:text-t1 tablet:size-11"
            aria-label="Hide the chat list"
            title={`Hide the chat list  ${keycap(KEYS.chatList)}`}
            onClick={onHide}
          >
            <PanelLeftClose />
          </Button>
        </div>
      )}
      {/*
        On a desktop, a new workspace: a tab of its own, one blank window with its New chat (#2791). On a phone, one chat
        at a time: New chat is at the foot of the list, in the thumb's reach.
      */}
      {!phone && (
        <Button
          data-tour="new-workspace"
          variant="ghost"
          className="justify-start gap-2 px-2 text-t2 hover:text-t1 tablet:h-11"
          onClick={() => workspace.current?.command("newTab")}
        >
          <SquarePlus />
          New workspace
        </Button>
      )}
      <label
        data-tour="search-chats"
        className="mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-t3 focus-within:bg-l1 tablet:h-11"
      >
        <Search className="size-3.5 shrink-0" />
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search"
          className="min-w-0 flex-1 self-stretch bg-transparent text-[0.8125rem] text-t1 outline-none placeholder:text-t3"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div data-tour="chat-list" className="min-h-0 flex-1 overflow-y-auto short:min-h-36">
        {elsewhere.length > 0 && (
          <Section label="Running in other folders">{elsewhere.map(runningRow)}</Section>
        )}
        {waiting.length > 0 && <Section label="Needs you">{waiting.map(row)}</Section>}
        {pinned.length > 0 && <Section label="Pinned">{pinned.map(row)}</Section>}
        {/* One array, keyed by chat: a chat whose file comes keeps its row's element as it moves to its saved row. */}
        <Section label="Chats">{[...starting.map(startingRow), ...rest.map(row)]}</Section>
        {needle !== "" && shown.length === 0 && starting.length === 0 && elsewhere.length === 0 && (
          <p className="px-2 py-1 text-xs text-t3">No chat's title has "{query.trim()}".</p>
        )}
      </div>
      {problem !== null && (
        <p role="alert" className="px-2 py-1 text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <WhatsNew workspace={workspace} onAllUpdates={onWhatsNew} />
      {phone ? (
        // A phone's foot: New chat in the thumb's reach, the inbox and Settings (What's new and the theme are there).
        <div className="flex items-center gap-1 px-1 pt-2 [&_button]:min-h-11 [&_button]:min-w-11">
          <Button
            data-tour="new-chat"
            variant="secondary"
            className="flex-1 gap-2"
            onClick={() => onOpen({ kind: "new", folder }, "here")}
          >
            <SquarePen />
            New chat
          </Button>
          {connection}
          <InboxButton onOpenChat={(target) => onOpen(target, "here")} />
          <Button
            data-tour="settings"
            variant="ghost"
            size="icon"
            aria-label="Settings"
            className="text-t2"
            onClick={onSettings}
          >
            <Settings />
          </Button>
        </div>
      ) : (
        <div className="px-1 pt-2">
          {connection}
          {/* On a tablet the full-size buttons go on a row of their own under the theme switch: one row is too narrow. */}
          <div className="flex items-center justify-between pt-1 tablet:flex-wrap tablet:gap-y-1">
            <ThemeSwitch />
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      data-tour="whats-new-button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="What's new"
                      className="text-t3 hover:text-t1 tablet:size-11"
                      onClick={onWhatsNew}
                    />
                  }
                >
                  <Sparkles />
                </TooltipTrigger>
                <TooltipContent side="top">What's new: every update and its tours</TooltipContent>
              </Tooltip>
              <InboxButton onOpenChat={(target) => onOpen(target, "here")} />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      data-tour="settings"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Settings"
                      aria-keyshortcuts="Control+,"
                      className="text-t3 hover:text-t1 tablet:size-11"
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
        </div>
      )}
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
      <AlertDialog open={confirmingStop} onOpenChange={setConfirmingStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{stopping?.title ?? ""}” is in the middle of a turn: it ends now, as Esc ends it. The
              chat stays in its folder's list, and opening it starts it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (stopping !== null) stopNow(stopping.id);
              }}
            >
              Stop running
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {edge}
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

/** Pin and Delete behind a phone's row swiped to the left, 72 px each. */
const SWIPE_WIDTH = 144;

/** What a saved chat's row offers besides opening it: reading it ahead, its pin, and its menu's Rename and Delete. */
interface RowActions {
  readonly pinned: boolean;
  readonly onPrefetch: () => void;
  readonly onPin: () => void;
  readonly onRename: (typed: string) => void;
  readonly onDelete: () => void;
}

function ChatRow({
  title,
  place,
  state,
  saving,
  open,
  focused,
  target,
  onOpen,
  phone,
  actions,
  onStop,
  swiped = false,
  onSwipe,
}: {
  readonly title: string;
  /** The folder it runs in, when that is not the list's (D1): its name in small type after the title. */
  readonly place?: string;
  readonly state: ChatState;
  /** A new title is on its way to omp: shown already, muted until omp has saved it. */
  readonly saving: boolean;
  readonly open: boolean;
  readonly focused: boolean;
  /** The chat the row opens, and carries when dragged onto the workspace. */
  readonly target: ChatTarget;
  readonly onOpen: (target: ChatTarget, where: "here" | "split") => void;
  /** On a phone the row has no buttons: a touch-and-hold opens its menu, Pin there too. */
  readonly phone: boolean;
  /** None for a chat whose first reply still runs: it has no file to read ahead, pin, rename or delete yet. */
  readonly actions?: RowActions;
  /** Stop running in its menu, for a chat that runs on the server now (D1). */
  readonly onStop?: () => void;
  /** On a phone: the row is swiped open, showing Pin and Delete. One row at a time: the list keeps which. */
  readonly swiped?: boolean;
  readonly onSwipe?: (open: boolean) => void;
}): ReactNode {
  // A pointer passing over the list reads nothing; one that rests on a row a moment reads that chat ahead.
  const resting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  /** Rename was chosen in the menu: the closing menu leaves the caret in the title field. */
  const renaming = useRef(false);
  /** The rename ended with Enter or Esc: the caret goes back to the row. */
  const refocus = useRef(false);
  const titleButton = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The row has a menu: a saved chat's Rename and Delete, a running chat's Stop running, or both. */
  const hasMenu = actions !== undefined || onStop !== undefined;
  const hold = useLongPress(() => {
    if (hasMenu) setMenuOpen(true);
  });
  const swipe = useSwipe(SWIPE_WIDTH, swiped, (next) => onSwipe?.(next), hold.onPointerCancel);
  /** A phone's row with actions slides on a track, its Pin and Delete just past its right edge. */
  const track = phone && actions !== undefined;
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    titleButton.current?.focus();
  }, [editing]);
  const said = [
    title,
    place === undefined ? null : `in ${place}`,
    state === "waiting"
      ? "waiting for you"
      : state === "paused"
        ? "paused"
        : state === "running"
          ? "running"
          : state === "continuing"
            ? "continues after its usage limit"
            : null,
    open ? "open in a window" : null,
  ].filter((part) => part !== null);
  return (
    <li
      className={cn(
        "group/row flex items-center rounded-md hover:bg-l1 has-[[aria-current=true]]:bg-l2",
        track && "relative overflow-hidden",
      )}
      // The list shuts an open row when a finger lands anywhere else.
      data-swiped={swiped ? "true" : undefined}
      onPointerEnter={() => {
        if (actions !== undefined)
          resting.current = setTimeout(actions.onPrefetch, PREFETCH_REST_MS);
      }}
      onPointerLeave={() => clearTimeout(resting.current)}
      // A press opens the chat, which reads its file itself: a read ahead after it would read it twice (#2768).
      onPointerDown={() => clearTimeout(resting.current)}
    >
      <div
        className={cn(
          "relative flex min-w-0 flex-1 items-center",
          track && !swipe.dragging && "transition-transform duration-200 ease-out",
        )}
        style={track ? { transform: `translateX(${-swipe.offset}px)` } : undefined}
      >
        {editing ? (
          <RenameField
            title={title}
            onDone={(typed, byKey) => {
              renaming.current = false;
              refocus.current = byKey;
              setEditing(false);
              if (typed !== null) actions?.onRename(typed);
            }}
          />
        ) : (
          <button
            ref={titleButton}
            type="button"
            className={cn(
              "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-t2 outline-none group-hover/row:text-t1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-busy:text-t3 aria-[current=true]:text-t1 max-sm:h-11 tablet:h-11",
              // A second line for the folder's name: a little taller on a desktop; a touch row has the room.
              place !== undefined && "h-auto min-h-8 py-1",
              // Up and down stay the list's scroll; left and right are the row's swipe.
              phone && "touch-pan-y",
            )}
            aria-current={focused ? "true" : undefined}
            aria-busy={saving ? "true" : undefined}
            // One phrase for a screen reader: the title, its state, and whether a pane shows it.
            aria-label={said.join(", ")}
            onClick={(event) => {
              // Both are asked, so neither keeps a skip for a later click.
              const held = hold.endsHold();
              const shut = swipe.endsSwipe();
              if (held || shut) return;
              onOpen(target, event.altKey ? "split" : "here");
            }}
            {...(phone
              ? {
                  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
                    hold.onPointerDown(event);
                    swipe.onPointerDown(event);
                  },
                  onPointerMove: swipe.onPointerMove,
                  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
                    swipe.onPointerUp();
                    hold.onPointerUp(event);
                  },
                  onPointerLeave: hold.onPointerLeave,
                  onPointerCancel: () => {
                    hold.onPointerCancel();
                    swipe.onPointerCancel();
                  },
                  onContextMenu: hold.onContextMenu,
                }
              : {
                  // Dropped on the workspace, the chat opens where it lands (the workspace's drop handling). A phone
                  // has no workspace to drop on, and its touch-and-hold opens the row's menu.
                  draggable: true,
                  onDragStart: (event: DragEvent<HTMLButtonElement>) =>
                    startChatDrag(event.dataTransfer, target),
                })}
          >
            {state === "paused" ? (
              // The tab's mark too: a paused turn is still a turn, and the pause is what matters.
              <Pause aria-hidden="true" className="size-3 shrink-0 text-warn-ink" />
            ) : state === "continuing" ? (
              <Clock aria-hidden="true" className="size-3 shrink-0 text-t2" />
            ) : (
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  state === "waiting" && "bg-warn",
                  state === "running" && "bg-live",
                )}
              />
            )}
            {place === undefined ? (
              <span className="min-w-0 flex-1 truncate">{title}</span>
            ) : (
              // The title keeps the row's width; the folder's name goes under it, in small type (D1).
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate">{title}</span>
                <span className="truncate text-[11px] text-t3">{place}</span>
              </span>
            )}
            {open && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-t3" />}
          </button>
        )}
        {!editing && hasMenu && (
          <>
            {!phone && actions !== undefined && (
              <button
                type="button"
                // In the row of its chat; the chat's title stays the name of the row's own button.
                aria-label={actions.pinned ? "Unpin" : "Pin"}
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-sm text-t3 hover:bg-l2 hover:text-t1 tablet:size-11",
                  REVEAL,
                )}
                onClick={actions.onPin}
              >
                {actions.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </button>
            )}
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                aria-label="More"
                // On a phone the trigger shows nothing and takes no taps: the menu opens on a touch-and-hold, at the
                // row's end. A screen reader still finds it.
                className={cn(
                  "grid shrink-0 place-items-center rounded-sm text-t3 outline-none hover:bg-l2 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-l2 data-popup-open:text-t1 data-popup-open:opacity-100",
                  phone
                    ? "pointer-events-none size-px opacity-0"
                    : cn("mr-1 size-6 tablet:size-11", REVEAL),
                )}
              >
                <Ellipsis className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-auto" finalFocus={() => !renaming.current}>
                {phone && actions !== undefined && (
                  <DropdownMenuItem onClick={actions.onPin}>
                    {actions.pinned ? <PinOff /> : <Pin />}
                    {actions.pinned ? "Unpin" : "Pin"}
                  </DropdownMenuItem>
                )}
                {actions !== undefined && (
                  <DropdownMenuItem
                    onClick={() => {
                      renaming.current = true;
                      setEditing(true);
                    }}
                  >
                    <PencilLine />
                    Rename
                  </DropdownMenuItem>
                )}
                {onStop !== undefined && (
                  <DropdownMenuItem onClick={onStop}>
                    <CircleStop />
                    Stop running
                  </DropdownMenuItem>
                )}
                {actions !== undefined && (
                  <DropdownMenuItem variant="destructive" onClick={actions.onDelete}>
                    <Trash2 />
                    Delete…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {track && actions !== undefined && !editing && (
          // Shut, the actions are hidden (no tap, tab stop or screen reader; the row's menu has them), once the row
          // has slid shut: the hiding waits out the slide.
          <div
            className={cn(
              "absolute inset-y-0 left-full flex",
              swiped || swipe.dragging
                ? "visible"
                : "invisible transition-[visibility] delay-200 duration-0",
            )}
          >
            <button
              type="button"
              className="w-18 bg-l3 font-medium text-t1 text-xs"
              onClick={() => {
                onSwipe?.(false);
                actions.onPin();
              }}
            >
              {actions.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              className="w-18 bg-(--bad-fill) font-medium text-white text-xs"
              onClick={() => {
                onSwipe?.(false);
                actions.onDelete();
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
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
        if (isImeEnter(event)) return;
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
      className="h-8 min-w-0 flex-1 rounded-md bg-l1 pr-2 pl-[22px] text-[0.8125rem] text-t1 outline-none ring-1 ring-ring ring-inset max-sm:h-11 tablet:h-11"
    />
  );
}
