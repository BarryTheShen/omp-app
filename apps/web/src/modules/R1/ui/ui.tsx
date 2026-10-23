import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import {
  type AppError,
  AppFailure,
  type RunningSession,
  SESSION_DELETE_RUNNING_TURN,
  type ThreadId,
} from "@omp-app/contracts";
import { Loader2Icon, PinIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { EmptyState, InlineError, ListRow, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ENTER_FADE, LEAVE_FADE, LEAVE_MS } from "@/lib/motion";
import { type Presence, useEnteringItems, usePresentItems } from "@/lib/presence";
import { useCoveredByModal } from "@/overlay";
import { useCapabilityStatus } from "@/registry-core";
import { useLeftSidebar } from "@/shell";
import { Icons } from "@/tokens";
import type { SessionCatalogModel } from "../catalog";
import type { SessionMetadata } from "../contract";
import { R1_SESSION_LIST_SCOPE } from "../descriptors/descriptors";
import { pickedModelFor } from "../history/picked-model";
import type { RemoteInitializeOptions } from "../remote";
import { useSessionListShortcuts } from "./session-list-shortcuts";

/** Where a New chat click stands: opening (omp is starting the chat), idle (nothing to say), or failed, with the reason. */
export type NewChatStatus =
  | { readonly state: "idle" }
  | { readonly state: "opening" }
  | { readonly state: "failed"; readonly error: AppError };

export interface SessionCatalogSidebarProps {
  readonly catalog: SessionCatalogModel;
  readonly remote: Pick<RemoteThreadListAdapter, "rename" | "archive" | "unarchive" | "delete"> & {
    /** The pick's open waits for the page (see `RemoteInitializeOptions`). */
    readonly initialize: (
      threadId: string,
      options?: RemoteInitializeOptions,
    ) => Promise<{ readonly remoteId: string; readonly externalId?: string }>;
  };
  readonly currentThreadId?: ThreadId;
  /** Opens a picked chat through the page. It resolves false when the chat did not open, and the page has shown why. */
  readonly onOpenThread?: (threadId: ThreadId) => unknown;
  readonly onNewChatStatus?: (status: NewChatStatus) => void;
  readonly onNewChat?: (threadId: ThreadId) => Promise<void> | void;
  /** Shows why a picked chat did not open, when the chat's saved model cannot be restored (the picker offers another). */
  readonly onOpenFailed?: (threadId: ThreadId, error: AppError) => void;
  readonly onDeletedOpenThread?: () => Promise<void> | void;
  readonly onPinChange?: (threadId: ThreadId, pinned: boolean) => Promise<void> | void;
  /** Asks before deletion; `restoreFocus` returns focus to the invoking row action if cancelled. */
  readonly confirmDelete?: (
    session: SessionMetadata,
    title: string,
    restoreFocus?: HTMLElement,
  ) => Promise<boolean> | boolean;
  readonly confirmDeleteRunning?: (title: string) => Promise<boolean> | boolean;
  /** Coalesces catalog refreshes that can arrive from the active-thread and running-change watchers. */
  readonly requestRefresh?: (catalog: SessionCatalogModel, limit?: number) => void;
  /**
   * Whether the open chat's turn runs now, read when a delete starts. An open chat whose turn runs is not left: the
   * delete says why it cannot be deleted, in that chat.
   */
  readonly currentTurnRunning?: () => boolean;
  readonly stopRunning?: (threadId: ThreadId) => Promise<void>;
}

function highlight(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const start = lower.indexOf(target);
  if (start < 0) return text;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-primary/20 px-0.5 text-inherit">
        {text.slice(start, start + needle.length)}
      </mark>
      {text.slice(start + needle.length)}
    </>
  );
}

/** The title's own words, without omp's card icon and code; else the first thing the user asked (omp titles a session after its first turn). */
export function sessionTitle(session: SessionMetadata): string {
  return session.displayTitle ?? session.firstPrompt ?? "New session";
}

function folderLabel(folder: string): string {
  const normalized = folder.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || folder;
}

/**
 * A pick the person made before a later one, where the later one opened first: the remote adapter reports the
 * earlier pick as cancelled. The later pick is the chat on screen, so the earlier one opens nothing and is no error.
 */
async function unlessSuperseded<Opened>(pick: Promise<Opened>): Promise<Opened | undefined> {
  try {
    return await pick;
  } catch (error) {
    if (error instanceof AppFailure && error.appError.code === "cancelled") return undefined;
    throw error;
  }
}

/** The reason a New chat that could not start gives the page. An error that is not an AppFailure is unexpected. */
function newChatFailure(error: unknown): AppError {
  if (error instanceof AppFailure) return error.appError;
  return { code: "internal", message: "Starting a new chat failed. Try again.", retryable: true };
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const branchedShort = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
});
const branchedFull = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/**
 * The line that marks a chat omp branched from another chat (a regenerated answer, or an edit). It is a
 * line of its own under the title, so it stays in view however long the title is. The time it was made
 * tells branches of one chat apart; the source's title is in the tooltip. Undefined for a chat that is no branch.
 */
function branchMarker(
  session: SessionMetadata,
  source: SessionMetadata | undefined,
): { readonly text: string; readonly tooltip: string } | undefined {
  if (session.parentSession === null) return undefined;
  const from = source ? `Branch of ${sessionTitle(source)}` : "Branch";
  const made = new Date(session.createdAt);
  if (Number.isNaN(made.getTime())) return { text: "Branch", tooltip: from };
  return {
    text: `Branch made ${branchedShort.format(made)}`,
    tooltip: `${from}, made ${branchedFull.format(made)}`,
  };
}

function activityPreview(updatedAt: string): { label: string; title: string } {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return { label: updatedAt, title: updatedAt };
  const deltaSeconds = (date.getTime() - Date.now()) / 1_000;
  const absoluteSeconds = Math.abs(deltaSeconds);
  const unit =
    absoluteSeconds < 60
      ? { divisor: 1, name: "second" as const }
      : absoluteSeconds < 3_600
        ? { divisor: 60, name: "minute" as const }
        : absoluteSeconds < 86_400
          ? { divisor: 3_600, name: "hour" as const }
          : { divisor: 86_400, name: "day" as const };
  const amount = Math.round(deltaSeconds / unit.divisor);
  const label =
    Math.abs(amount) > 7 && unit.name === "day"
      ? shortDate.format(date)
      : relativeTime.format(amount, unit.name);
  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    title: date.toLocaleString(),
  };
}

function capabilityReason(
  status: { state: string; detail?: string } | undefined,
  fallback: string,
): string {
  return status?.detail ?? fallback;
}

/**
 * Where each folder's list was scrolled to. The app rebuilds the sidebar each time a chat is
 * opened, and the list should stay where the reader left it.
 */
const scrollPositions = new WeakMap<SessionCatalogModel, number>();

/**
 * The New chat click that is starting, per catalog. The app rebuilds the sidebar each time a chat is opened, so a click
 * still waiting in the sidebar that started it must find the record its successor reads: a click that a later click or a
 * pick superseded then neither opens nor ends anything.
 */
const pendingNewChats = new WeakMap<SessionCatalogModel, { current: object | null }>();

function pendingNewChatOf(catalog: SessionCatalogModel): { current: object | null } {
  const existing = pendingNewChats.get(catalog);
  if (existing) return existing;
  const created: { current: object | null } = { current: null };
  pendingNewChats.set(catalog, created);
  return created;
}

/** The keys the presence hooks read chats by. Module-level, so the lists they return keep their identity between draws. */
const sessionKey = (session: SessionMetadata): string => session.id;
const runningKey = (chat: RunningSession): string => chat.id;

export function SessionCatalogSidebar({
  catalog,
  remote,
  currentThreadId,
  onOpenThread,
  onNewChat,
  onNewChatStatus,
  onOpenFailed,
  onDeletedOpenThread,
  onPinChange,
  confirmDelete,
  confirmDeleteRunning,
  requestRefresh,
  currentTurnRunning,
  stopRunning,
}: SessionCatalogSidebarProps) {
  const snapshot = catalog.getSnapshot();
  // The picked chat's row is the selected one from the pick on, before its open finishes (see openSession).
  const shownThreadId = snapshot.selectedThreadId ?? currentThreadId;
  const [query, setQuery] = useState(snapshot.filter.query);
  const [, setCatalogRevision] = useState(0);
  const [focusedId, setFocusedId] = useState<ThreadId | undefined>();
  const [editingId, setEditingId] = useState<ThreadId | undefined>();
  const [editingTitle, setEditingTitle] = useState("");
  const [renameError, setRenameError] = useState<string | undefined>();
  const [renaming, setRenaming] = useState(false);
  const renamingRef = useRef(false);
  const [focusRowId, setFocusRowId] = useState<ThreadId | undefined>();
  // The chat whose row option holds keyboard focus in the list, for as long as nothing else has taken the focus or a
  // press. A refresh can take that element out of the document (a running row is replaced by its listed row, or the
  // list moves the row); the layout effect below gives the focus back to the same chat's row.
  const focusOwner = useRef<ThreadId | undefined>(undefined);
  const rowElements = useRef(new Map<ThreadId, HTMLDivElement>());
  const moreButtons = useRef(new Map<ThreadId, HTMLButtonElement>());
  const [menuSessionId, setMenuSessionId] = useState<ThreadId | undefined>();
  const [menuPosition, setMenuPosition] = useState<{
    readonly left: number;
    readonly top: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openMenu = useCallback((id: ThreadId, button: HTMLButtonElement): void => {
    const rect = button.getBoundingClientRect();
    setMenuSessionId(id);
    setMenuPosition({ left: Math.max(4, rect.right - 112), top: rect.bottom + 4 });
  }, []);
  useLayoutEffect(() => {
    if (menuSessionId === undefined || menuPosition === null || menuRef.current === null) return;
    const button = moreButtons.current.get(menuSessionId);
    if (button === undefined) return;
    const buttonRect = button.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    const top =
      window.innerHeight - buttonRect.bottom >= menuRect.height + 4 ||
      buttonRect.top < menuRect.height + 4
        ? buttonRect.bottom + 4
        : buttonRect.top - menuRect.height - 4;
    const left = Math.min(
      Math.max(4, buttonRect.right - menuRect.width),
      Math.max(4, window.innerWidth - menuRect.width - 4),
    );
    if (top !== menuPosition.top || left !== menuPosition.left) setMenuPosition({ left, top });
  }, [menuPosition, menuSessionId]);
  useEffect(() => {
    if (menuSessionId === undefined) return;
    const close = (): void => setMenuSessionId(undefined);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [menuSessionId]);
  const previousCatalog = useRef(catalog);
  const refreshedMissingThread = useRef<{
    readonly catalog: SessionCatalogModel;
    readonly threadId: ThreadId;
  } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const newChatRef = useRef<HTMLButtonElement | null>(null);
  // The New chat that is starting, if any: a pick ends it (see `openSession`).
  const pendingNewChat = pendingNewChatOf(catalog);
  // The shell's left sidebar, when this list is in one: a refused pick reopens its narrow drawer (see `openSession`).
  const leftSidebar = useLeftSidebar();
  // A list behind an open modal repeats no refusal line: the list in the modal shows it, once.
  const coveredByModal = useCoveredByModal();
  const attachList = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
      if (element) element.scrollTop = scrollPositions.get(catalog) ?? 0;
    },
    [catalog],
  );
  const renameStatus = useCapabilityStatus("omp.cmd.set_session_name");
  const archiveStatus = useCapabilityStatus("upstream.session-archive");
  const pinStatus = useCapabilityStatus("host.session-pins");
  const deleteStatus = useCapabilityStatus("host.session-files");
  const canRename = renameStatus?.state === "available" || renameStatus?.state === "fallback";
  const canPin = pinStatus?.state === "available" || pinStatus?.state === "fallback";
  const canDelete = deleteStatus?.state === "available" || deleteStatus?.state === "fallback";

  useEffect(() => {
    const unsubscribe = catalog.subscribe(() => {
      setCatalogRevision((revision) => revision + 1);
    });
    return unsubscribe;
  }, [catalog]);
  useEffect(() => {
    // The list is fetched when the sidebar first opens, when the folder changes and when the
    // search changes. The app rebuilds the sidebar each time a chat is opened: a catalog that
    // already has its list is then left alone and its rows stay on screen, so opening a chat
    // fetches nothing and a refresh after a turn never shows placeholders.
    const catalogChanged = previousCatalog.current !== catalog;
    previousCatalog.current = catalog;
    const current = catalog.getSnapshot();
    if (!catalogChanged && current.isLoaded && current.filter.query === query) return;
    if (catalogChanged || current.filter.query !== query) setFocusedId(undefined);
    // A failed load is kept in the catalog's error, and the sidebar shows it with a retry.
    void catalog.list({ filter: { ...current.filter, query }, limit: 50 }).catch(() => undefined);
  }, [catalog, query]);
  useEffect(() => {
    if (currentThreadId === undefined || !snapshot.isLoaded || snapshot.isLoading) return;
    const current = catalog.getSnapshot();
    const refreshed = refreshedMissingThread.current;
    if (refreshed?.catalog === catalog && refreshed.threadId === currentThreadId) return;
    refreshedMissingThread.current = { catalog, threadId: currentThreadId };
    const listed =
      current.sessions.some((session) => session.id === currentThreadId) ||
      current.running.some((running) => running.id === currentThreadId);
    if (listed) return;
    // A branch/rewind creates a new omp file without a SessionFileChanged event; reread the current
    // folder once when the active thread is not in the already-loaded catalog.
    if (requestRefresh) requestRefresh(catalog, 100);
    else void catalog.list({ filter: current.filter, limit: 100 }).catch(() => undefined);
  }, [catalog, currentThreadId, requestRefresh, snapshot.isLoaded, snapshot.isLoading]);

  useEffect(() => {
    if (!menuSessionId) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!listRef.current?.contains(event.target as Node)) setMenuSessionId(undefined);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [menuSessionId]);

  // Presence tracks whether this session row joined the already-loaded list, so its entrance fade is not recomputed from
  // the session timestamp on every catalog update.
  const presentSessions = usePresentItems(
    snapshot.sessions,
    sessionKey,
    LEAVE_MS,
    snapshot.isLoaded && !snapshot.isLoading,
  );
  // A chat whose turn runs with no session file yet has a row in its folder until the list holds its file. A session that
  // is leaving still holds its row, so the chat's running row is not drawn beside it (the two would share a key).
  const runningChats = useMemo(
    () =>
      snapshot.running.filter(
        (chat) => !presentSessions.some((entry) => entry.item.id === chat.id),
      ),
    [snapshot.running, presentSessions],
  );
  // A running chat has no creation time to judge by: it fades in once, when it appears after the list has loaded.
  const enteringRunning = useEnteringItems(runningChats, runningKey, snapshot.isLoaded);
  const grouped = useMemo(() => {
    const groups = new Map<
      string,
      { running: Presence<RunningSession>[]; sessions: Presence<SessionMetadata>[] }
    >();
    const groupOf = (cwd: string) => {
      const group = groups.get(cwd) ?? { running: [], sessions: [] };
      groups.set(cwd, group);
      return group;
    };
    for (const entry of enteringRunning) groupOf(entry.item.folder).running.push(entry);
    for (const entry of presentSessions) groupOf(entry.item.cwd).sessions.push(entry);
    return [...groups.entries()];
  }, [enteringRunning, presentSessions]);
  const sessions = snapshot.sessions;
  const activeSearch = snapshot.filter.query.trim();
  // Every row, in the order it is drawn: each folder's running chats, then its listed chats (see `grouped`).
  const rowIds = useMemo(
    () =>
      grouped.flatMap(([, group]) => [
        ...group.running.map((entry) => entry.item.id),
        // A session that is leaving is inert and fading out: the keys never reach it.
        ...group.sessions.filter((entry) => !entry.leaving).map((entry) => entry.item.id),
      ]),
    [grouped],
  );
  // The focused row is a chat, not a position: when the list reorders under it, the row and Enter still mean that
  // chat. A chat that has left the list, or none yet, puts the tab stop on the first row.
  // The tab stop starts on the open chat, so Tab back into the list lands on it (issue 973). A chat the person focused wins.
  const focusedRow = rowIds.findIndex((id) => id === (focusedId ?? shownThreadId));
  const activeIndex = focusedRow >= 0 ? focusedRow : 0;

  // After a rename (or Escape) the chat's own row takes focus and becomes the focused row. The focus is kept by
  // the chat's id, so the arrow keys continue from it wherever the row sits in the list.
  useEffect(() => {
    if (focusRowId === undefined) return;
    setFocusedId(focusRowId);
    rowElements.current.get(focusRowId)?.querySelector<HTMLElement>('[role="option"]')?.focus();
    setFocusRowId(undefined);
  }, [focusRowId]);

  // Focus that moves to an element outside the list, or a press outside the owner's row, is the person's choice: the
  // owner lets go of it, so the list does not take the focus back later.
  useEffect(() => {
    const focusMoved = (event: FocusEvent): void => {
      if (!(event.target instanceof Node) || listRef.current?.contains(event.target) !== true) {
        focusOwner.current = undefined;
      }
    };
    const pressed = (event: PointerEvent): void => {
      const owner = focusOwner.current;
      if (owner === undefined) return;
      const row = rowElements.current.get(owner);
      if (!(event.target instanceof Node) || row?.contains(event.target) !== true) {
        focusOwner.current = undefined;
      }
    };
    document.addEventListener("focusin", focusMoved, true);
    document.addEventListener("pointerdown", pressed, true);
    return () => {
      document.removeEventListener("focusin", focusMoved, true);
      document.removeEventListener("pointerdown", pressed, true);
    };
  }, []);

  // A refresh can take the focused row out of the document: a running row is replaced by its listed row, or the list
  // moves the row. The focus then falls to the body within the same commit, so before paint the owner's row (the same
  // chat, wherever it now is) takes it again. It does not scroll: the reader's place in the list stays where it was.
  useLayoutEffect(() => {
    const owner = focusOwner.current;
    if (owner === undefined) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    rowElements.current
      .get(owner)
      ?.querySelector<HTMLElement>('[role="option"]')
      ?.focus({ preventScroll: true });
  });

  // A delete asks for focus through the catalog (see requestFocus), so the request lands here even when a chat switch
  // rebuilt the sidebar, and a row that is not in the list yet takes it when it arrives.
  const focusRequest = snapshot.focus;
  useEffect(() => {
    if (focusRequest === undefined) return;
    if (focusRequest.kind === "newChat") {
      newChatRef.current?.focus();
      catalog.requestFocus(undefined);
      return;
    }
    // The row takes the request once the list holds it; until then the request waits for the next change of the list.
    if (!rowIds.includes(focusRequest.id)) return;
    const option = rowElements.current
      .get(focusRequest.id)
      ?.querySelector<HTMLElement>('[role="option"]');
    if (!option) return;
    option.focus();
    setFocusedId(focusRequest.id);
    catalog.requestFocus(undefined);
  }, [catalog, focusRequest, rowIds]);

  /**
   * Opens a chat through the page, which reports whether the chat opened. The page reports a refusal of the chat's model
   * where the chat opens (the picker over the open chat, or the empty screen), so that refusal is not raised again here:
   * the chat did not open, and the result is false.
   */
  const openThreadReported = async (threadId: ThreadId): Promise<boolean> => {
    try {
      return (await onOpenThread?.(threadId)) !== false;
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "model_unavailable") return false;
      throw error;
    }
  };

  const openSession = async (session: Pick<SessionMetadata, "id">): Promise<void> => {
    catalog.setActionError(undefined);
    // A pick ends a New chat that is still starting: the chat picked is the one the person is in now.
    if (pendingNewChat.current !== null) {
      pendingNewChat.current = null;
      onNewChatStatus?.({ state: "idle" });
    }
    const threadId = session.id as ThreadId;
    // The picked row is selected at once; the pick stands until its chat has opened, or was refused.
    catalog.select(threadId);
    const pick = catalog.getSnapshot().selectionRevision;
    try {
      // The page opens the chat first, so it shows at the click (issue 2212). The runtime numbers this pick now, at the
      // click, so the picks keep the order of the clicks: a New chat clicked meanwhile keeps its place. The runtime's
      // own open waits for the page's answer, so the view the page holds registers before the runtime lets its own go
      // (issue 1353). A page refusal, or a later pick, opens nothing.
      const pageOpened = openThreadReported(threadId).then(
        (opened) => opened && catalog.getSnapshot().selectedThreadId === threadId,
      );
      const initializing = remote.initialize(session.id, { after: pageOpened });
      // A refused or superseded pick's rejection is not raised here: its result is not shown.
      void initializing.catch(() => undefined);
      if (!(await pageOpened)) return;
      try {
        await unlessSuperseded(initializing);
      } catch (error) {
        if (!(error instanceof AppFailure) || error.appError.code !== "model_unavailable")
          throw error;
        // The page's open already retried a remembered model. Otherwise omp refused the chat before it opened: the picker,
        // over the open chat or on the empty screen, says so once.
        if (pickedModelFor(threadId) === undefined) onOpenFailed?.(threadId, error.appError);
      }
    } catch (error) {
      // The open was refused because another omp holds the chat: the refusal shows on the chat's row. On a narrow layout the
      // sessions drawer closed when the row was picked, so it opens again first (committed, so the row can take focus).
      if (error instanceof AppFailure && error.appError.conflictReason === "held_elsewhere") {
        flushSync(() => leftSidebar?.show());
        catalog.setHeldError(error.appError.message, threadId);
        catalog.requestFocus({ kind: "row", id: threadId });
        return;
      }
      throw error;
    } finally {
      // A later pick has the selection now, or this pick is over: the open chat's row shows again.
      if (catalog.getSnapshot().selectionRevision === pick) catalog.select(null);
    }
  };

  /**
   * A click on a session row opens its chat, unless it lands on one of the row's own controls (its title button, More, the
   * actions menu): those act for themselves. The saved row and the running row both use it, so they cannot drift apart.
   */
  const openRowUnlessControl = (
    target: EventTarget,
    session: Pick<SessionMetadata, "id">,
  ): void => {
    if ((target as Element).closest("button, input, [role='menu']") === null)
      void openSession(session);
  };

  const createNewChat = async (): Promise<void> => {
    catalog.setActionError(undefined);
    const token = {};
    pendingNewChat.current = token;
    onNewChatStatus?.({ state: "opening" });
    // Reports the end unless a pick already ended this New chat, and reported that itself.
    const finish = (status: NewChatStatus): void => {
      if (pendingNewChat.current !== token) return;
      pendingNewChat.current = null;
      onNewChatStatus?.(status);
    };
    try {
      const initialized = await unlessSuperseded(remote.initialize("new"));
      // A chat picked since the click is the one the person wants: this New chat does not open over it.
      if (initialized && pendingNewChat.current === token) {
        await onNewChat?.(initialized.remoteId as ThreadId);
      }
      finish({ state: "idle" });
    } catch (error) {
      finish({ state: "failed", error: newChatFailure(error) });
    }
  };

  /** Keeps each chat's row element, so the keyboard can go back to the row after a rename. */
  const rememberRow = (id: ThreadId, element: HTMLDivElement | null): void => {
    if (element) rowElements.current.set(id, element);
    else rowElements.current.delete(id);
  };

  const beginRename = (session: SessionMetadata): void => {
    catalog.setActionError(undefined);
    setEditingId(session.id);
    // The box opens with the title's own words, so omp's card icon is not shown in it. A save stores what is typed.
    setEditingTitle(sessionTitle(session));
    setRenameError(undefined);
  };

  /** Closes the rename box; focus then goes to the chat's own row, not to the list as a whole. */
  const endRename = (session: SessionMetadata): void => {
    setEditingId(undefined);
    setRenameError(undefined);
    setFocusRowId(session.id);
  };

  const finishRename = async (session: SessionMetadata): Promise<void> => {
    // Enter pressed again while a save runs is ignored: the first one owns the rename.
    if (renamingRef.current) return;
    const nextTitle = editingTitle.trim();
    if (nextTitle.length === 0 || nextTitle === sessionTitle(session)) {
      endRename(session);
      return;
    }
    renamingRef.current = true;
    setRenaming(true);
    setRenameError(undefined);
    try {
      await remote.rename(session.id, nextTitle);
    } catch (error) {
      // The box stays open with the typed title, so the person can try again or press Escape.
      setRenameError(error instanceof Error ? error.message : "The chat could not be renamed.");
      return;
    } finally {
      renamingRef.current = false;
      setRenaming(false);
    }
    endRename(session);
  };
  const togglePin = async (session: SessionMetadata): Promise<void> => {
    setMenuSessionId(undefined);
    if (!canPin || !onPinChange) return;
    const pinned = !session.pinned;
    await onPinChange(session.id, pinned);
    await catalog.reconcilePin(session.id, pinned, "ui");
  };

  /** Moves focus to the chat's row: its ring shows, and Enter opens the row that has focus. */
  const focusRow = (index: number): boolean => {
    const id = rowIds[index];
    const option =
      id === undefined
        ? undefined
        : rowElements.current.get(id)?.querySelector<HTMLElement>('[role="option"]');
    if (!option) return false;
    option.focus();
    return true;
  };

  /** The index of the chat whose row (its option) this element is; -1 when it is no row. */
  const rowIndexOf = (element: HTMLElement): number =>
    rowIds.findIndex(
      (id) =>
        rowElements.current.get(id)?.querySelector<HTMLElement>('[role="option"]') === element,
    );

  /** The chat whose row holds this element, if any: the row's option or one of its controls. */
  const rowIdOf = (element: EventTarget): ThreadId | undefined => {
    if (!(element instanceof Node)) return undefined;
    return rowIds.find((id) => rowElements.current.get(id)?.contains(element) === true);
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (rowIds.length === 0) return;
    // A key pressed in a row's rename box or on its More actions button belongs to that control.
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && target.getAttribute("role") !== "option") return;
    // The key acts on the row it came from, so a list that reordered under the focus is read as it is now.
    const fromRow = rowIndexOf(target);
    const current = fromRow >= 0 ? fromRow : activeIndex;
    const last = rowIds.length - 1;
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(current + 1, last);
    else if (event.key === "ArrowUp") next = Math.max(current - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next !== undefined) {
      // Alt, Ctrl, Meta and Shift combinations belong to the browser (Alt+Left is Back): the list keeps plain keys only.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // The focus itself moves, so the row the arrow keys reach is the row Enter opens.
      event.preventDefault();
      const row = rowIds[next];
      if (row !== undefined && focusRow(next)) setFocusedId(row);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const focused = rowIds[current];
      if (focused !== undefined) void openSession({ id: focused });
    }
  };
  const deleteRunningSession = async (sessionId: ThreadId, title: string): Promise<void> => {
    if (!canDelete || stopRunning === undefined || confirmDeleteRunning === undefined) return;
    if (!(await confirmDeleteRunning(title))) return;
    catalog.setActionError(undefined);
    try {
      await stopRunning(sessionId);
      await remote.delete(sessionId);
      if (sessionId === currentThreadId) {
        if (onDeletedOpenThread) await onDeletedOpenThread();
        else await createNewChat();
      }
      requestRefresh?.(catalog);
      catalog.requestFocus({ kind: "newChat" });
    } catch (error) {
      catalog.setActionError(
        error instanceof Error ? error.message : "The chat could not be deleted.",
        sessionId,
      );
      catalog.requestFocus({ kind: "row", id: sessionId });
    }
  };

  /** Deletes a chat. `confirm` asks first (the More actions item and Mod+Shift+Backspace); Mod+Backspace deletes at once. */
  const deleteSession = async (session: SessionMetadata, confirm: boolean): Promise<void> => {
    if (!canDelete) return;
    const trigger = moreButtons.current.get(session.id);
    if (confirm && !(await confirmDelete?.(session, sessionTitle(session), trigger ?? undefined))) {
      return;
    }
    // Focus moves to the neighbouring row once the chat is gone: the next row, else the one above.
    const index = rowIds.indexOf(session.id);
    const neighbour = index < 0 ? undefined : (rowIds[index + 1] ?? rowIds[index - 1]);
    try {
      // A chat whose turn streams in this view is refused here, with no round trip: the live store
      // knows it, and a turn that was just sent may not be busy on the server yet.
      if (session.id === currentThreadId && currentTurnRunning?.() === true) {
        catalog.setActionError(SESSION_DELETE_RUNNING_TURN, session.id);
        catalog.requestFocus({ kind: "row", id: session.id });
        return;
      }
      // The server decides first. It refuses a chat whose turn runs (a background job keeps it
      // busy) or that another tab or window holds, and the refusal shows here while the chat stays
      // on screen. The view leaves an open chat only once the server has deleted it.
      const selectionBefore = catalog.getSnapshot().selectionRevision;
      await remote.delete(session.id);
      // A chat the person picks while the server answers, or is still opening, is the one they want:
      // a new chat must not take its place, because it would be the later pick.
      const after = catalog.getSnapshot();
      const picked = after.selectionRevision !== selectionBefore || after.selectedThreadId !== null;
      if (session.id === currentThreadId && !picked) {
        if (onDeletedOpenThread) await onDeletedOpenThread();
        else await createNewChat();
      }
      catalog.requestFocus(neighbour ? { kind: "row", id: neighbour } : { kind: "newChat" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The chat could not be deleted.";
      // The server's running-turn sentence is the local refusal's sentence, so the line ends with this chat's turn.
      catalog.setActionError(
        message,
        message === SESSION_DELETE_RUNNING_TURN ? session.id : undefined,
      );
      // The chat stays, so focus stays on its row rather than falling to the page body.
      catalog.requestFocus({ kind: "row", id: session.id });
    }
  };

  /**
   * The chat the keyboard is on: the row that has focus (or its More actions button), else the tab stop row.
   * A running row (a chat with no session file yet) has no actions, so the keys do nothing on it.
   */
  const keyboardSession = (): SessionMetadata | undefined => {
    const active = document.activeElement;
    const id =
      rowIds.find((rowId) => rowElements.current.get(rowId)?.contains(active) === true) ??
      rowIds[activeIndex];
    return sessions.find((session) => session.id === id);
  };
  useSessionListShortcuts({
    rename: () => {
      const session = keyboardSession();
      if (session && canRename) beginRename(session);
    },
    deleteAfterConfirmation: () => {
      const session = keyboardSession();
      return session ? deleteSession(session, true) : Promise.resolve();
    },
    deleteWithoutConfirmation: () => {
      const session = keyboardSession();
      return session ? deleteSession(session, false) : Promise.resolve();
    },
  });

  return (
    <aside
      aria-label="Session list"
      className="flex min-h-0 w-full flex-col bg-sidebar px-3 text-sidebar-foreground"
    >
      <div className="flex shrink-0 items-center">
        <Button
          ref={newChatRef}
          className="border-foreground/10 bg-background hover:border-foreground/25 rounded-control flex h-8 w-full shrink-0 items-center justify-start gap-2 border px-2.5 text-sm transition-colors"
          data-shell-new-chat="true"
          type="button"
          variant="outline"
          onClick={() => void createNewChat()}
        >
          <Icons.add aria-hidden="true" className="size-3.5" />
          New chat
        </Button>
      </div>
      <div className="relative px-0.5 py-1">
        <Icons.search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
        />
        <Input
          aria-label="Search sessions"
          className="h-8 ps-8 text-sm border-foreground/10 bg-background"
          placeholder="Search sessions"
          value={query}
          onChange={(event) => {
            catalog.setActionError(undefined);
            setQuery(event.target.value);
          }}
        />
      </div>
      {snapshot.isLoading && !snapshot.isLoaded && (
        <div aria-label="Loading sessions" className="flex flex-col gap-2 p-3" role="status">
          <div className="bg-muted h-8 animate-pulse rounded-lg" />
          <div className="bg-muted h-8 animate-pulse rounded-lg" />
          <div className="bg-muted h-8 animate-pulse rounded-lg" />
        </div>
      )}
      {!snapshot.isLoading && snapshot.error && !snapshot.isLoaded && (
        <InlineError
          message={snapshot.error.message}
          onRetry={() =>
            void catalog.list({ filter: snapshot.filter, limit: 50 }).catch(() => undefined)
          }
        />
      )}
      {snapshot.error && snapshot.isLoaded && (
        <p className="text-destructive px-3 py-1 text-xs leading-snug" role="status">
          Couldn't refresh sessions. Showing the last list.
        </p>
      )}
      {renameError && (
        <p className="text-destructive px-3 py-1 text-xs leading-snug" role="alert">
          {renameError}
        </p>
      )}
      {snapshot.actionError && !coveredByModal && (
        <p className="text-destructive px-3 py-1 text-xs leading-snug text-balance" role="alert">
          {snapshot.actionError}
        </p>
      )}
      {snapshot.isLoaded && rowIds.length === 0 && activeSearch.length === 0 && (
        <EmptyState
          title="No sessions in this folder"
          hint="Start a new chat to create an omp session."
          action={
            <Button
              data-shell-new-chat="true"
              type="button"
              size="sm"
              onClick={() => void createNewChat()}
            >
              New chat
            </Button>
          }
        />
      )}
      {/* A search with no match is not an empty folder: its chats are still there. */}
      {snapshot.isLoaded && rowIds.length === 0 && activeSearch.length > 0 && (
        <EmptyState
          title={`No chats match "${activeSearch}"`}
          hint="Clear the search to see every chat in this folder."
        />
      )}
      {rowIds.length > 0 && (
        <div
          ref={attachList}
          aria-label="Session list"
          className="-mx-3 min-h-0 flex-1 overflow-y-auto px-3"
          data-focus-scope={R1_SESSION_LIST_SCOPE}
          role="listbox"
          onKeyDown={(event) => {
            if (
              menuSessionId !== undefined &&
              (event.key === "PageUp" ||
                event.key === "PageDown" ||
                event.key === "Home" ||
                event.key === "End")
            ) {
              setMenuSessionId(undefined);
            }
            onListKeyDown(event);
          }}
          onWheel={() => {
            if (menuSessionId !== undefined) setMenuSessionId(undefined);
          }}
          onTouchMove={() => {
            if (menuSessionId !== undefined) setMenuSessionId(undefined);
          }}
          onScroll={(event) => scrollPositions.set(catalog, event.currentTarget.scrollTop)}
          onFocus={(event) => {
            // Only a row's option owns the focus. Its controls (More actions, menu items, the rename box) do not.
            const isOption =
              event.target instanceof HTMLElement && event.target.getAttribute("role") === "option";
            focusOwner.current = isOption ? rowIdOf(event.target) : undefined;
          }}
        >
          {grouped.map(([cwd, group]) => (
            <Section
              key={cwd}
              ariaLabel={cwd}
              heading={folderLabel(cwd)}
              headingTooltip={cwd}
              headingLevel={3}
              variant="plain"
            >
              <div className="flex flex-col gap-0.5">
                {[
                  // A chat that stops running moves from its running row to its listed row. Both come from this one array,
                  // keyed by chat id, so React keeps the row's element and the chat's row is not re-created (issue 2212).
                  ...group.running.map((presence) => {
                    const chat = presence.item;
                    const title = "New chat";
                    const menuOpen = menuSessionId === chat.id;
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: the title button inside is the keyboard and screen reader control; this click only widens the pointer target to the row body, as the saved row does.
                      // biome-ignore lint/a11y/useKeyWithClickEvents: the same reason; Enter and Space on the title button open the chat.
                      <div
                        className={
                          presence.entering
                            ? `group data-[selected=true]:bg-foreground/[0.06] data-[selected=true]:text-foreground hover:bg-foreground/[0.04] rounded-control relative flex min-h-8 shrink-0 items-center text-muted-foreground transition-colors ${ENTER_FADE}`
                            : "group data-[selected=true]:bg-foreground/[0.06] data-[selected=true]:text-foreground hover:bg-foreground/[0.04] rounded-control relative flex min-h-8 shrink-0 items-center text-muted-foreground transition-colors"
                        }
                        data-selected={shownThreadId === chat.id ? "true" : "false"}
                        data-slot="r1-running-row"
                        key={chat.id}
                        onClick={(event) => openRowUnlessControl(event.target, { id: chat.id })}
                        ref={(element) => rememberRow(chat.id, element)}
                      >
                        <ListRow
                          title="New chat"
                          detail={
                            <span className="text-meta text-muted-foreground group-data-[selected=true]:text-foreground group-hover:text-foreground flex w-full min-w-0 items-center gap-1">
                              <Loader2Icon
                                aria-hidden="true"
                                className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                                data-slot="r1-session-running"
                              />
                              Running
                            </span>
                          }
                          selected={shownThreadId === chat.id}
                          tabIndex={rowIds.indexOf(chat.id) === activeIndex ? 0 : -1}
                          trailing={
                            <Toolbar ariaLabel={`Actions for ${title}`}>
                              <Button
                                ref={(element) => {
                                  if (element) moreButtons.current.set(chat.id, element);
                                  else moreButtons.current.delete(chat.id);
                                }}
                                aria-expanded={menuOpen}
                                aria-haspopup="menu"
                                aria-label={`More actions for ${title}`}
                                className="text-muted-foreground hover:text-foreground absolute end-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm opacity-0 transition-colors group-hover:opacity-100 group-focus-within:opacity-100 group-data-[selected=true]:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                                size="icon-xs"
                                tabIndex={rowIds.indexOf(chat.id) === activeIndex ? 0 : -1}
                                title="More actions"
                                type="button"
                                variant="ghost"
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (menuOpen) setMenuSessionId(undefined);
                                  else openMenu(chat.id, event.currentTarget);
                                }}
                                onKeyDown={(event) => {
                                  // Escape closes the menu this button opened; the focus stays on the button (issue 973).
                                  if (event.key === "Escape" && menuOpen) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setMenuSessionId(undefined);
                                  }
                                }}
                              >
                                <Icons.more aria-hidden="true" className="size-3.5" />
                              </Button>
                            </Toolbar>
                          }
                          onSelect={() => void openSession({ id: chat.id })}
                          onFocus={() => setFocusedId(chat.id)}
                        />
                        {menuOpen && (
                          <div
                            aria-label={`Actions for ${title}`}
                            className="bg-popover text-popover-foreground rounded-surface z-50 min-w-28 overflow-hidden border p-1 fixed flex flex-col gap-0.5"
                            ref={menuRef}
                            role="menu"
                            style={
                              menuPosition === null
                                ? undefined
                                : { left: menuPosition.left, top: menuPosition.top }
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setMenuSessionId(undefined);
                                moreButtons.current.get(chat.id)?.focus();
                              }
                            }}
                          >
                            <Button
                              aria-label={`Delete and stop ${title}`}
                              disabled={
                                !canDelete ||
                                stopRunning === undefined ||
                                confirmDeleteRunning === undefined
                              }
                              role="menuitem"
                              size="xs"
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setMenuSessionId(undefined);
                                void deleteRunningSession(chat.id, title);
                              }}
                            >
                              Delete and stop
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  }),
                  ...group.sessions.map((presence) => {
                    const session = presence.item;
                    const leaving = presence.leaving;
                    const index = rowIds.indexOf(session.id);
                    const selected = shownThreadId === session.id;
                    const isEditing = editingId === session.id;
                    const title = sessionTitle(session);
                    const activity = activityPreview(session.updatedAt);
                    const running = session.turn === "running";
                    const source =
                      session.parentSession === null
                        ? undefined
                        : snapshot.sessions.find(
                            (item) => item.sessionFile === session.parentSession,
                          );
                    const marker = branchMarker(session, source);
                    const menuOpen = menuSessionId === session.id;
                    const pinReason = canPin
                      ? onPinChange
                        ? session.pinned
                          ? "Unpin"
                          : "Pin"
                        : "Pinning is unavailable"
                      : capabilityReason(pinStatus, "Pinning is unavailable");
                    return (
                      <div
                        aria-hidden={leaving || undefined}
                        className={
                          leaving
                            ? `group data-[selected=true]:bg-foreground/[0.06] data-[selected=true]:text-foreground hover:bg-foreground/[0.04] has-data-[state=open]:bg-foreground/[0.04] [&>div]:!bg-transparent [&>div:hover]:!bg-transparent [&>div[data-selected=true]]:!bg-transparent rounded-control relative flex min-h-8 shrink-0 items-center text-muted-foreground transition-colors ${LEAVE_FADE}`
                            : presence.entering
                              ? `group data-[selected=true]:bg-foreground/[0.06] data-[selected=true]:text-foreground hover:bg-foreground/[0.04] has-data-[state=open]:bg-foreground/[0.04] [&>div]:!bg-transparent [&>div:hover]:!bg-transparent [&>div[data-selected=true]]:!bg-transparent rounded-control relative flex min-h-8 shrink-0 items-center text-muted-foreground transition-colors ${ENTER_FADE}`
                              : "group data-[selected=true]:bg-foreground/[0.06] data-[selected=true]:text-foreground hover:bg-foreground/[0.04] has-data-[state=open]:bg-foreground/[0.04] [&>div]:!bg-transparent [&>div:hover]:!bg-transparent [&>div[data-selected=true]]:!bg-transparent rounded-control relative flex min-h-8 shrink-0 items-center text-muted-foreground transition-colors"
                        }
                        data-selected={selected ? "true" : "false"}
                        data-slot="r1-session-row"
                        inert={leaving || undefined}
                        key={session.id}
                        onClick={(event) => openRowUnlessControl(event.target, { id: session.id })}
                        ref={(element) => rememberRow(session.id, element)}
                      >
                        <ListRow
                          title={
                            isEditing ? (
                              <Input
                                className="w-full focus-visible:ring-inset"
                                aria-busy={isEditing && renaming ? true : undefined}
                                aria-label={`Rename ${title}`}
                                autoFocus
                                readOnly={renaming}
                                value={editingTitle}
                                onChange={(event) => setEditingTitle(event.target.value)}
                                onClick={(event) => event.stopPropagation()}
                                onFocus={(event) => event.currentTarget.select()}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void finishRename(session);
                                  }
                                  if (event.key === "Escape") endRename(session);
                                }}
                              />
                            ) : (
                              highlight(title, query)
                            )
                          }
                          titleTooltip={isEditing ? undefined : title}
                          leading={
                            session.pinned ? (
                              <PinIcon
                                aria-label="Pinned"
                                className="text-primary size-3 shrink-0"
                                role="img"
                              />
                            ) : undefined
                          }
                          detail={
                            isEditing && renaming ? (
                              <span className="text-meta text-muted-foreground" role="status">
                                Saving…
                              </span>
                            ) : (
                              <>
                                {marker && (
                                  <span
                                    className="text-meta text-muted-foreground block truncate"
                                    title={marker.tooltip}
                                  >
                                    {marker.text}
                                  </span>
                                )}
                                <span className="text-meta text-muted-foreground group-data-[selected=true]:text-foreground group-hover:text-foreground flex w-full min-w-0 items-center gap-1 truncate">
                                  {running && (
                                    <span className="flex shrink-0 items-center" title="Running">
                                      <Loader2Icon
                                        aria-hidden="true"
                                        className="size-3 animate-spin motion-reduce:animate-none"
                                        data-slot="r1-session-running"
                                      />
                                      <span className="sr-only">Running</span>
                                    </span>
                                  )}
                                  {/* A branch's line above gives the time it was made, so its update time is left out (issue 1314). */}
                                  {marker === undefined && (
                                    <time dateTime={session.updatedAt} title={activity.title}>
                                      {activity.label}
                                    </time>
                                  )}
                                  {snapshot.git?.branch && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span
                                        className="truncate"
                                        title={`Branch: ${snapshot.git.branch}`}
                                      >
                                        {snapshot.git.branch}
                                      </span>
                                    </>
                                  )}
                                </span>
                              </>
                            )
                          }
                          selected={selected}
                          tabIndex={index === activeIndex ? 0 : -1}
                          onSelect={!isEditing ? () => void openSession(session) : undefined}
                          onFocus={!isEditing ? () => setFocusedId(session.id) : undefined}
                          trailing={
                            <Toolbar ariaLabel={`Actions for ${title}`}>
                              <Button
                                ref={(element) => {
                                  if (element) moreButtons.current.set(session.id, element);
                                  else moreButtons.current.delete(session.id);
                                }}
                                aria-expanded={menuOpen}
                                aria-haspopup="menu"
                                aria-label={`More actions for ${title}`}
                                className="text-muted-foreground hover:text-foreground absolute end-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm opacity-0 transition-colors group-hover:opacity-100 group-focus-within:opacity-100 group-data-[selected=true]:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                                size="icon-xs"
                                tabIndex={index === activeIndex ? 0 : -1}
                                title="More actions"
                                type="button"
                                variant="ghost"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  catalog.setActionError(undefined);
                                  if (menuOpen) setMenuSessionId(undefined);
                                  else openMenu(session.id, event.currentTarget);
                                }}
                                onKeyDown={(event) => {
                                  // Escape closes the menu this button opened; the focus stays on the button (issue 973).
                                  if (event.key === "Escape" && menuOpen) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setMenuSessionId(undefined);
                                  }
                                }}
                              >
                                <Icons.more aria-hidden="true" className="size-3.5" />
                              </Button>
                            </Toolbar>
                          }
                        />
                        {menuOpen && (
                          <div
                            aria-label={`Actions for ${title}`}
                            className="bg-popover text-popover-foreground border-foreground/10 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out rounded-surface z-50 min-w-28 overflow-hidden border p-1 fixed flex flex-col gap-0.5"
                            ref={menuRef}
                            role="menu"
                            style={
                              menuPosition === null
                                ? undefined
                                : { left: menuPosition.left, top: menuPosition.top }
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setMenuSessionId(undefined);
                                // The item that had focus leaves with the menu, so the chat's More actions button takes it back (issue 1059).
                                moreButtons.current.get(session.id)?.focus();
                              }
                            }}
                          >
                            <Button
                              aria-label={`Rename ${title}`}
                              disabled={!canRename}
                              role="menuitem"
                              className="hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none"
                              size="xs"
                              title={
                                canRename
                                  ? "Rename"
                                  : capabilityReason(renameStatus, "Rename is unavailable")
                              }
                              type="button"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                setMenuSessionId(undefined);
                                beginRename(session);
                              }}
                            >
                              Rename
                            </Button>
                            <Button
                              aria-label={`${session.pinned ? "Unpin" : "Pin"} ${title}`}
                              disabled={!canPin || !onPinChange}
                              role="menuitem"
                              className="hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none"
                              size="xs"
                              title={pinReason}
                              type="button"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                void togglePin(session);
                              }}
                            >
                              {session.pinned ? "Unpin" : "Pin"}
                            </Button>
                            {running && stopRunning && confirmDeleteRunning ? (
                              <Button
                                aria-label={`Delete and stop ${title}`}
                                disabled={!canDelete}
                                role="menuitem"
                                className="hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none"
                                size="xs"
                                title="Stop this chat, then delete it"
                                type="button"
                                variant="ghost"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setMenuSessionId(undefined);
                                  void deleteRunningSession(session.id, title);
                                }}
                              >
                                Delete and stop
                              </Button>
                            ) : null}
                            <Button
                              aria-label={`Delete ${title}`}
                              disabled={!canDelete}
                              role="menuitem"
                              className="hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none"
                              size="xs"
                              title={
                                canDelete
                                  ? "Delete"
                                  : capabilityReason(
                                      deleteStatus,
                                      "Deleting a chat isn't available in the app yet.",
                                    )
                              }
                              type="button"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                setMenuSessionId(undefined);
                                void deleteSession(session, true);
                              }}
                            >
                              Delete
                            </Button>
                            <Button
                              aria-label={`Archive ${title}`}
                              disabled
                              role="menuitem"
                              className="hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none"
                              size="xs"
                              title={capabilityReason(
                                archiveStatus,
                                "Archive is unavailable at the omp release floor",
                              )}
                              type="button"
                              variant="ghost"
                            >
                              Archive
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  }),
                ]}
              </div>
            </Section>
          ))}
        </div>
      )}
      {!snapshot.isLoading && sessions.length > 0 && snapshot.nextCursor !== null && (
        // Outside the listbox (a listbox holds only options) and pinned under it, so it is always
        // in reach however far the list is scrolled.
        <div className="flex shrink-0 flex-col gap-1 p-2">
          {snapshot.moreError ? (
            <p className="text-destructive px-1 text-xs" role="alert">
              Couldn't load older chats. {snapshot.moreError.message}
            </p>
          ) : null}
          <Button
            disabled={snapshot.isLoadingMore}
            className="text-muted-foreground hover:text-foreground rounded-control mt-1 flex h-8 shrink-0 items-center px-2 text-sm transition-colors"
            type="button"
            variant="ghost"
            onClick={() => void catalog.loadMore()}
          >
            {snapshot.isLoadingMore
              ? "Loading older chats…"
              : snapshot.moreError
                ? "Try again"
                : "Show older chats"}
          </Button>
        </div>
      )}
    </aside>
  );
}
