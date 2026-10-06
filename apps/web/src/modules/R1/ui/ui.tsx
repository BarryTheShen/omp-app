import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { ThreadId } from "@omp-app/contracts";
import { MoreHorizontalIcon, PinIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [menuSessionId, setMenuSessionId] = useState<ThreadId | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
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
      setFocusedIndex(0);
    });
    void catalog.list({ filter: { ...catalog.getSnapshot().filter, query }, limit: 50 });
    return unsubscribe;
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

  const openSession = async (session: SessionMetadata): Promise<void> => {
    const initialized = await remote.initialize(session.id);
    await onOpenThread?.(initialized.remoteId as ThreadId);
  };

  const createNewChat = async (): Promise<void> => {
    const initialized = await remote.initialize("new");
    await onNewChat?.(initialized.remoteId as ThreadId);
  };

  const beginRename = (session: SessionMetadata): void => {
    setEditingId(session.id);
    setEditingTitle(session.title ?? "");
  };

  const finishRename = async (session: SessionMetadata): Promise<void> => {
    const nextTitle = editingTitle.trim();
    if (nextTitle.length === 0 || nextTitle === session.title) {
      setEditingId(undefined);
      return;
    }
    await remote.rename(session.id, nextTitle);
    setEditingId(undefined);
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
      <div className="-mt-10 flex h-10 shrink-0 items-center justify-end border-b border-sidebar-border pe-12 ps-2">
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
      {snapshot.isLoading && (
        <div aria-label="Loading sessions" className="flex flex-col gap-2 p-3" role="status">
          <div className="bg-muted h-8 animate-pulse rounded-lg" />
          <div className="bg-muted h-8 animate-pulse rounded-lg" />
          <div className="bg-muted h-8 animate-pulse rounded-lg" />
        </div>
      )}
      {!snapshot.isLoading && snapshot.error && (
        <div className="flex flex-col gap-2 p-4 text-sm" role="alert">
          <p className="text-destructive">{snapshot.error.message}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void catalog.list({ filter: snapshot.filter, limit: 50 })}
          >
            Retry
          </Button>
        </div>
      )}
      {!snapshot.isLoading && !snapshot.error && sessions.length === 0 && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-sm font-medium">No sessions in this folder</p>
          <p className="text-muted-foreground text-xs">
            Start a new chat to create an omp session.
          </p>
          <Button type="button" size="sm" onClick={() => void createNewChat()}>
            New chat
          </Button>
        </div>
      )}
      {!snapshot.isLoading && !snapshot.error && sessions.length > 0 && (
        <div
          ref={listRef}
          aria-label="Session list"
          className="min-h-0 flex-1 overflow-y-auto p-2"
          role="listbox"
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {grouped.map(([cwd, groupedSessions]) => (
            <section key={cwd} aria-label={cwd} className="mb-3 last:mb-0">
              <h3
                className="text-muted-foreground truncate px-2 py-1 text-xs font-medium"
                title={cwd}
              >
                {folderLabel(cwd)}
              </h3>
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
                  <div key={session.id} className="group relative mb-1">
                    <button
                      aria-selected={selected}
                      className="hover:bg-sidebar-accent focus-visible:ring-ring flex w-full min-w-0 flex-col items-start rounded-lg px-2 py-1.5 pe-8 text-left text-sm outline-none focus-visible:ring-2 data-[selected=true]:bg-sidebar-accent"
                      data-selected={selected}
                      role="option"
                      tabIndex={index === focusedIndex ? 0 : -1}
                      type="button"
                      onClick={() => void openSession(session)}
                      onFocus={() => setFocusedIndex(index)}
                    >
                      {isEditing ? (
                        <Input
                          aria-label={`Rename ${title}`}
                          autoFocus
                          value={editingTitle}
                          onChange={(event) => setEditingTitle(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void finishRename(session);
                            }
                            if (event.key === "Escape") setEditingId(undefined);
                          }}
                        />
                      ) : (
                        <span className="flex w-full min-w-0 items-center gap-1">
                          {session.pinned && (
                            <PinIcon
                              aria-label="Pinned"
                              className="text-primary size-3 shrink-0"
                              role="img"
                            />
                          )}
                          <span className="min-w-0 truncate font-medium" title={title}>
                            {highlight(title, query)}
                          </span>
                        </span>
                      )}
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
                    </button>
                    <div className="absolute end-1 top-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        aria-expanded={menuOpen}
                        aria-haspopup="menu"
                        aria-label={`More actions for ${title}`}
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
                    </div>
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
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}
