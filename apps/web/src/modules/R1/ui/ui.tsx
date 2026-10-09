import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { ThreadId } from "@omp-app/contracts";
import { MoreHorizontalIcon, PinIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, InlineError, ListRow, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapabilityStatus } from "@/registry-core";
import type { SessionCatalogModel } from "../catalog";
import type { SessionMetadata } from "../contract";

export interface SessionCatalogSidebarProps {
  readonly catalog: SessionCatalogModel;
  readonly remote: Pick<
    RemoteThreadListAdapter,
    "initialize" | "rename" | "archive" | "unarchive" | "delete"
  >;
  readonly currentThreadId?: ThreadId;
  readonly onOpenThread?: (threadId: ThreadId) => Promise<void> | void;
  readonly onNewChat?: (threadId: ThreadId) => Promise<void> | void;
  readonly onPinChange?: (threadId: ThreadId, pinned: boolean) => Promise<void> | void;
  readonly confirmDelete?: (session: SessionMetadata) => Promise<boolean> | boolean;
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

/** omp's title, else the first thing the user asked (omp titles a session after its first turn). */
function sessionTitle(session: SessionMetadata): string {
  return session.title ?? session.firstPrompt ?? "New session";
}

function folderLabel(folder: string): string {
  const normalized = folder.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || folder;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

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

export function SessionCatalogSidebar({
  catalog,
  remote,
  currentThreadId,
  onOpenThread,
  onNewChat,
  onPinChange,
  confirmDelete,
}: SessionCatalogSidebarProps) {
  const snapshot = catalog.getSnapshot();
  const [query, setQuery] = useState(snapshot.filter.query);
  const [, setCatalogRevision] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [editingId, setEditingId] = useState<ThreadId | undefined>();
  const [editingTitle, setEditingTitle] = useState("");
  const [renameError, setRenameError] = useState<string | undefined>();
  const [renaming, setRenaming] = useState(false);
  const renamingRef = useRef(false);
  const [focusRowId, setFocusRowId] = useState<ThreadId | undefined>();
  const rowElements = useRef(new Map<ThreadId, HTMLDivElement>());
  const [menuSessionId, setMenuSessionId] = useState<ThreadId | undefined>();
  const previousCatalog = useRef(catalog);
  const listRef = useRef<HTMLDivElement | null>(null);
  const attachList = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
      if (element) element.scrollTop = scrollPositions.get(catalog) ?? 0;
    },
    [catalog],
  );
  const renameStatus = useCapabilityStatus("omp.cmd.set_session_name");
  const deleteStatus = useCapabilityStatus("host.command-gateway");
  const archiveStatus = useCapabilityStatus("upstream.session-archive");
  const pinStatus = useCapabilityStatus("host.session-pins");
  const canRename = renameStatus?.state === "available" || renameStatus?.state === "fallback";
  const canDelete = deleteStatus?.state === "available" || deleteStatus?.state === "fallback";
  const canPin = pinStatus?.state === "available" || pinStatus?.state === "fallback";

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
    if (catalogChanged || current.filter.query !== query) setFocusedIndex(0);
    void catalog.list({ filter: { ...current.filter, query }, limit: 50 });
  }, [catalog, query]);

  useEffect(() => {
    if (!menuSessionId) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!listRef.current?.contains(event.target as Node)) setMenuSessionId(undefined);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [menuSessionId]);

  const grouped = useMemo(() => {
    const groups = new Map<string, SessionMetadata[]>();
    for (const session of snapshot.sessions) {
      const list = groups.get(session.cwd) ?? [];
      list.push(session);
      groups.set(session.cwd, list);
    }
    return [...groups.entries()];
  }, [snapshot.sessions]);
  const sessions = snapshot.sessions;

  // After a rename (or Escape) the chat's own row takes focus and becomes the focused row, so the
  // arrow keys continue from it. It runs once the list shows the saved title, where the row sits now.
  useEffect(() => {
    if (focusRowId === undefined) return;
    const index = sessions.findIndex((session) => session.id === focusRowId);
    if (index >= 0) setFocusedIndex(index);
    rowElements.current.get(focusRowId)?.querySelector<HTMLElement>('[role="option"]')?.focus();
    setFocusRowId(undefined);
  }, [focusRowId, sessions]);

  const openSession = async (session: SessionMetadata): Promise<void> => {
    const initialized = await remote.initialize(session.id);
    await onOpenThread?.(initialized.remoteId as ThreadId);
  };

  const createNewChat = async (): Promise<void> => {
    const initialized = await remote.initialize("new");
    await onNewChat?.(initialized.remoteId as ThreadId);
  };

  /** Keeps each chat's row element, so the keyboard can go back to the row after a rename. */
  const rememberRow = (id: ThreadId, element: HTMLDivElement | null): void => {
    if (element) rowElements.current.set(id, element);
    else rowElements.current.delete(id);
  };

  const beginRename = (session: SessionMetadata): void => {
    setEditingId(session.id);
    setEditingTitle(session.title ?? "");
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
    if (nextTitle.length === 0 || nextTitle === session.title) {
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

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (sessions.length === 0) return;
    // A key pressed in a row's rename box or on its More actions button belongs to that control.
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && target.getAttribute("role") !== "option") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedIndex((index) => Math.min(index + 1, sessions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFocusedIndex(sessions.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const focused = sessions[focusedIndex];
      if (focused) void openSession(focused);
    }
  };

  return (
    <aside
      aria-label="Sessions"
      className="flex min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex shrink-0 items-center justify-end border-b border-sidebar-border p-2">
        <Button type="button" size="sm" onClick={() => void createNewChat()}>
          New chat
        </Button>
      </div>
      <div className="border-b border-sidebar-border p-3">
        <Input
          aria-label="Search sessions"
          placeholder="Search sessions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
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
          onRetry={() => void catalog.list({ filter: snapshot.filter, limit: 50 })}
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
      {snapshot.isLoaded && sessions.length === 0 && (
        <EmptyState
          title="No sessions in this folder"
          hint="Start a new chat to create an omp session."
          action={
            <Button type="button" size="sm" onClick={() => void createNewChat()}>
              New chat
            </Button>
          }
        />
      )}
      {sessions.length > 0 && (
        <div
          ref={attachList}
          aria-label="Session list"
          className="min-h-0 flex-1 overflow-y-auto p-2"
          role="listbox"
          tabIndex={0}
          onKeyDown={onListKeyDown}
          onScroll={(event) => scrollPositions.set(catalog, event.currentTarget.scrollTop)}
        >
          {grouped.map(([cwd, groupedSessions]) => (
            <Section
              key={cwd}
              ariaLabel={cwd}
              heading={folderLabel(cwd)}
              headingTooltip={cwd}
              headingLevel={3}
              variant="plain"
            >
              {groupedSessions.map((session) => {
                const index = sessions.findIndex((item) => item.id === session.id);
                const selected = currentThreadId === session.id;
                const isEditing = editingId === session.id;
                const title = sessionTitle(session);
                const activity = activityPreview(session.updatedAt);
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
                    key={session.id}
                    className="group relative mb-1"
                    ref={(element) => rememberRow(session.id, element)}
                  >
                    <ListRow
                      title={
                        isEditing ? (
                          <Input
                            aria-busy={isEditing && renaming ? true : undefined}
                            aria-label={`Rename ${title}`}
                            autoFocus
                            readOnly={renaming}
                            value={editingTitle}
                            onChange={(event) => setEditingTitle(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
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
                          <span className="text-muted-foreground text-xs" role="status">
                            Saving…
                          </span>
                        ) : (
                          <span className="text-muted-foreground flex w-full min-w-0 items-center gap-1 truncate text-xs">
                            <time dateTime={session.updatedAt} title={activity.title}>
                              {activity.label}
                            </time>
                            {snapshot.git?.branch && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="truncate" title={`Branch: ${snapshot.git.branch}`}>
                                  {snapshot.git.branch}
                                </span>
                              </>
                            )}
                          </span>
                        )
                      }
                      selected={selected}
                      tabIndex={index === focusedIndex ? 0 : -1}
                      onSelect={!isEditing ? () => void openSession(session) : undefined}
                      onFocus={!isEditing ? () => setFocusedIndex(index) : undefined}
                      trailing={
                        <Toolbar ariaLabel={`Actions for ${title}`}>
                          <Button
                            aria-expanded={menuOpen}
                            aria-haspopup="menu"
                            aria-label={`More actions for ${title}`}
                            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                            size="icon-xs"
                            title="More actions"
                            type="button"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuSessionId(menuOpen ? undefined : session.id);
                            }}
                          >
                            <MoreHorizontalIcon aria-hidden="true" />
                          </Button>
                        </Toolbar>
                      }
                    />
                    {menuOpen && (
                      <div
                        aria-label={`Actions for ${title}`}
                        className="border-border bg-popover text-popover-foreground shadow-overlay absolute end-1 top-8 z-10 flex min-w-32 flex-col gap-0.5 rounded-md border p-1"
                        role="menu"
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setMenuSessionId(undefined);
                          }
                        }}
                      >
                        <Button
                          aria-label={`Rename ${title}`}
                          disabled={!canRename}
                          role="menuitem"
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
                        <Button
                          aria-label={`Delete ${title}`}
                          disabled={!canDelete}
                          role="menuitem"
                          size="xs"
                          title={
                            canDelete
                              ? "Delete"
                              : capabilityReason(deleteStatus, "Delete is unavailable")
                          }
                          type="button"
                          variant="ghost"
                          onClick={async (event) => {
                            event.stopPropagation();
                            setMenuSessionId(undefined);
                            if (!canDelete || !(await confirmDelete?.(session))) return;
                            await remote.delete(session.id);
                          }}
                        >
                          Delete
                        </Button>
                        <Button
                          aria-label={`Archive ${title}`}
                          disabled
                          role="menuitem"
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
              })}
            </Section>
          ))}
        </div>
      )}
      {!snapshot.isLoading && sessions.length > 0 && snapshot.nextCursor !== null && (
        // Outside the listbox (a listbox holds only options) and pinned under it, so it is always
        // in reach however far the list is scrolled.
        <div className="border-sidebar-border flex shrink-0 flex-col gap-1 border-t p-2">
          {snapshot.moreError ? (
            <p className="text-destructive px-1 text-xs" role="alert">
              Couldn't load older chats. {snapshot.moreError.message}
            </p>
          ) : null}
          <Button
            disabled={snapshot.isLoadingMore}
            size="sm"
            type="button"
            variant="outline"
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
