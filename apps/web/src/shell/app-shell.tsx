/**
 * U0's serving-independent application shell. The desktop layout is a stable three-column grid;
 * below the narrow breakpoint each sidebar becomes an in-place drawer until U0.4 supplies the
 * shared OverlayHost. All regions are slots so U1/U2/U5/N1 can compose into this shell without
 * changing its landmarks or geometry.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Icons, spacingTokens, zIndexTokens } from "@/tokens";
import { useShellPreferences } from "./preferences";
import { ResizeHandle } from "./resize-handle";
import { useMediaQuery } from "./use-media-query";

const NARROW_QUERY = "(max-width: 48rem)";
const MIN_SIDEBAR_WIDTH = 14;
const MAX_SIDEBAR_WIDTH = 32;
const MAX_SIDEBAR_VIEWPORT = "24vw";

export interface AppShellProps {
  readonly leftSidebar?: ReactNode;
  readonly threadHeader?: ReactNode;
  readonly transcript?: ReactNode;
  readonly composer?: ReactNode;
  readonly rightSidebar?: ReactNode;
  readonly statusBar?: ReactNode;
}

/** The right sidebar as a panel rendered inside it sees it: whether it is open, and how to open it. */
export interface RightSidebar {
  readonly open: boolean;
  readonly show: () => void;
}

const RightSidebarContext = createContext<RightSidebar | null>(null);

/** The right sidebar of the shell that renders the caller; null when rendered outside a shell. */
export function useRightSidebar(): RightSidebar | null {
  return useContext(RightSidebarContext);
}

function DefaultLeftSidebar() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm font-medium text-sidebar-foreground">No sessions yet</p>
      <p className="text-muted-foreground max-w-52 text-xs leading-relaxed">
        Start a conversation to see its session here.
      </p>
    </div>
  );
}

function DefaultThreadHeader() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold tracking-tight">omp</h1>
        <p className="text-muted-foreground truncate text-xs">New conversation</p>
      </div>
    </div>
  );
}

function DefaultTranscript() {
  return (
    <div className="mx-auto flex w-full max-w-(--layout-thread-width) flex-1 flex-col justify-center px-6 py-12 text-center">
      <p className="text-lg font-medium tracking-tight">Ready when you are</p>
      <p className="text-muted-foreground mt-2 text-sm">
        Your conversation will appear here once a session is open.
      </p>
    </div>
  );
}

/** The composer's place while no chat is open: its text says what to do first. */
export function ComposerNote({ children }: { readonly children: ReactNode }) {
  return (
    <div className="border-border bg-card text-muted-foreground rounded-xl border px-4 py-3 text-sm">
      {children}
    </div>
  );
}

function DefaultComposer() {
  return <ComposerNote>Open a session to start composing.</ComposerNote>;
}

function DefaultRightSidebar() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm font-medium text-sidebar-foreground">No panel selected</p>
      <p className="text-muted-foreground max-w-52 text-xs leading-relaxed">
        Context and task panels will appear here.
      </p>
    </div>
  );
}

function DefaultStatusBar({ persistenceStatus }: { persistenceStatus: "ready" | "unavailable" }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 px-4 py-1.5 text-xs">
      <span className="text-muted-foreground" data-shell-status="ready">
        Ready
      </span>
      {persistenceStatus === "unavailable" && (
        <span className="text-warning" data-shell-status="persistence" role="status">
          Layout preferences could not be saved
        </span>
      )}
    </div>
  );
}

function SidebarToggle({
  side,
  open,
  onToggle,
}: {
  readonly side: "left" | "right";
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const label = side === "left" ? "sessions" : "panels";
  return (
    <Button
      aria-controls={`shell-${label}-sidebar`}
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "Show"} ${label} sidebar`}
      aria-keyshortcuts={side === "left" ? "Control+B Meta+B" : "Control+Shift+B Meta+Shift+B"}
      data-shell-sidebar-toggle={side}
      size="icon-sm"
      title={`${open ? "Hide" : "Show"} ${label} sidebar`}
      variant="ghost"
      onClick={onToggle}
    >
      {side === "left" ? (
        open ? (
          <Icons.chevronLeft aria-hidden="true" />
        ) : (
          <Icons.chevronRight aria-hidden="true" />
        )
      ) : open ? (
        <Icons.chevronRight aria-hidden="true" />
      ) : (
        <Icons.chevronLeft aria-hidden="true" />
      )}
    </Button>
  );
}

function SidebarHeader({
  side,
  open,
  onToggle,
}: {
  readonly side: "left" | "right";
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const label = side === "left" ? "Sessions" : "Panels";
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3">
      <h2 className="text-sm font-semibold tracking-tight">{label}</h2>
      <Button
        aria-label={`Collapse ${label.toLowerCase()} sidebar`}
        aria-expanded={open}
        data-shell-sidebar-collapse={side}
        size="icon-sm"
        title={`Collapse ${label.toLowerCase()} sidebar`}
        variant="ghost"
        onClick={onToggle}
      >
        {side === "left" ? (
          <Icons.chevronLeft aria-hidden="true" />
        ) : (
          <Icons.chevronRight aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/** The complete U0 shell with stable landmarks, responsive drawers, and persisted sidebar widths. */
export function AppShell({
  leftSidebar = <DefaultLeftSidebar />,
  threadHeader = <DefaultThreadHeader />,
  transcript = <DefaultTranscript />,
  composer = <DefaultComposer />,
  rightSidebar = <DefaultRightSidebar />,
  statusBar,
}: AppShellProps) {
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const { preferences, persistenceStatus, setLeftSidebarWidth, setRightSidebarWidth } =
    useShellPreferences();
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const showRightSidebar = useCallback(() => {
    if (isNarrow) setLeftOpen(false);
    setRightOpen(true);
  }, [isNarrow]);
  const rightSidebarControl = useMemo<RightSidebar>(
    () => ({ open: rightOpen, show: showRightSidebar }),
    [rightOpen, showRightSidebar],
  );

  useEffect(() => {
    if (!isNarrow) return;
    setLeftOpen(false);
    setRightOpen(false);
  }, [isNarrow]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) return;

      if (event.key === "Escape" && isNarrow) {
        if (rightOpen) setRightOpen(false);
        else if (leftOpen) setLeftOpen(false);
        return;
      }

      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "b")
        return;

      event.preventDefault();
      if (event.shiftKey) {
        if (isNarrow) setLeftOpen(false);
        setRightOpen((open) => !open);
      } else {
        if (isNarrow) setRightOpen(false);
        setLeftOpen((open) => !open);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isNarrow, leftOpen, rightOpen]);

  const toggleLeft = () => {
    if (isNarrow) setRightOpen(false);
    setLeftOpen((open) => !open);
  };
  const toggleRight = () => {
    if (isNarrow) setLeftOpen(false);
    setRightOpen((open) => !open);
  };

  const sidebarTrack = (width: number, open: boolean) =>
    open ? `minmax(0, min(${width}rem, ${MAX_SIDEBAR_VIEWPORT}))` : "0";
  const columns = isNarrow
    ? "minmax(0, 1fr)"
    : `${sidebarTrack(preferences.leftSidebarWidth, leftOpen)} minmax(0, 1fr) ${sidebarTrack(preferences.rightSidebarWidth, rightOpen)}`;
  const sidebarWidth = (side: "left" | "right", open: boolean) => {
    if (!open) return "0";
    if (isNarrow) return `calc(100% - ${spacingTokens.xl})`;
    return `min(${side === "left" ? preferences.leftSidebarWidth : preferences.rightSidebarWidth}rem, ${MAX_SIDEBAR_VIEWPORT})`;
  };
  const hasDrawer = isNarrow && (leftOpen || rightOpen);

  return (
    <div
      className="relative grid h-dvh min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground"
      data-shell-layout={isNarrow ? "narrow" : "wide"}
      style={{ gridTemplateColumns: columns }}
    >
      {hasDrawer && (
        <button
          aria-label="Close open sidebar"
          className="absolute inset-0 bg-background/70 backdrop-blur-xs"
          data-shell-drawer-backdrop="true"
          style={{ zIndex: zIndexTokens.overlay - 1 }}
          tabIndex={-1}
          type="button"
          onClick={() => {
            if (rightOpen) setRightOpen(false);
            else setLeftOpen(false);
          }}
        />
      )}

      <nav
        aria-hidden={!leftOpen}
        aria-label="Sessions"
        className={cn(
          "relative row-span-2 flex min-h-0 min-w-0 flex-col overflow-hidden border-e border-sidebar-border bg-sidebar transition-[width,opacity] duration-200 motion-reduce:transition-none",
          isNarrow && "absolute inset-y-0 start-0 h-full shadow-overlay",
          !leftOpen && "pointer-events-none opacity-0",
        )}
        data-open={leftOpen}
        data-shell-sidebar="left"
        hidden={!leftOpen}
        id="shell-sessions-sidebar"
        style={{
          width: sidebarWidth("left", leftOpen),
          zIndex: isNarrow ? zIndexTokens.overlay : undefined,
        }}
      >
        <SidebarHeader side="left" open={leftOpen} onToggle={() => setLeftOpen(false)} />
        <div className="flex min-h-0 flex-1 flex-col">{leftSidebar}</div>
        {!isNarrow && leftOpen && (
          <ResizeHandle
            maximum={MAX_SIDEBAR_WIDTH}
            minimum={MIN_SIDEBAR_WIDTH}
            side="left"
            value={preferences.leftSidebarWidth}
            onChange={setLeftSidebarWidth}
          />
        )}
      </nav>

      <main
        aria-label="Conversation"
        className="col-start-1 row-start-1 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
        data-shell-main="true"
        id="main-content"
        style={{ gridColumn: isNarrow ? "1" : "2" }}
      >
        <header
          className="flex min-h-12 items-center gap-2 border-b border-border px-3"
          data-shell-region="header"
        >
          <SidebarToggle side="left" open={leftOpen} onToggle={toggleLeft} />
          {threadHeader}
          <SidebarToggle side="right" open={rightOpen} onToggle={toggleRight} />
        </header>
        {/* A labelled region, not role="log": a log is a live region, so every streamed token
            would be announced. U1.8's polite status announces new content instead. */}
        <section
          aria-label="Conversation transcript"
          className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain"
          data-shell-region="transcript"
        >
          {transcript}
        </section>
        <section
          aria-label="Composer"
          className="shrink-0 border-t border-border bg-background"
          data-shell-region="composer"
        >
          {/* The composer shares the conversation's width, so its edges line up with the messages. */}
          <div className="mx-auto w-full max-w-(--layout-thread-width) px-6 py-3">{composer}</div>
        </section>
      </main>

      <aside
        aria-hidden={!rightOpen}
        aria-label="Panels"
        className={cn(
          "relative row-span-2 flex min-h-0 min-w-0 flex-col overflow-hidden border-s border-sidebar-border bg-sidebar transition-[width,opacity] duration-200 motion-reduce:transition-none",
          isNarrow && "absolute inset-y-0 end-0 h-full shadow-overlay",
          !rightOpen && "pointer-events-none opacity-0",
        )}
        data-open={rightOpen}
        data-shell-sidebar="right"
        hidden={!rightOpen}
        id="shell-panels-sidebar"
        style={{
          width: sidebarWidth("right", rightOpen),
          zIndex: isNarrow ? zIndexTokens.overlay : undefined,
        }}
      >
        <SidebarHeader side="right" open={rightOpen} onToggle={() => setRightOpen(false)} />
        <RightSidebarContext.Provider value={rightSidebarControl}>
          <div className="flex min-h-0 flex-1 flex-col">{rightSidebar}</div>
        </RightSidebarContext.Provider>
        {!isNarrow && rightOpen && (
          <ResizeHandle
            maximum={MAX_SIDEBAR_WIDTH}
            minimum={MIN_SIDEBAR_WIDTH}
            side="right"
            value={preferences.rightSidebarWidth}
            onChange={setRightSidebarWidth}
          />
        )}
      </aside>

      <footer
        aria-label="Status"
        className="col-start-1 row-start-2 border-t border-border bg-background"
        data-shell-region="status"
        role="contentinfo"
        style={{ gridColumn: isNarrow ? "1" : "2" }}
      >
        {statusBar ?? <DefaultStatusBar persistenceStatus={persistenceStatus} />}
      </footer>
    </div>
  );
}
