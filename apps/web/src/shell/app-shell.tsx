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
  useRef,
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

/** The drawer open in the narrow layout: one at a time, and none in the wide layout. */
type Drawer = "left" | "right" | null;

export interface AppShellProps {
  readonly leftSidebar?: ReactNode;
  readonly threadHeader?: ReactNode;
  readonly transcript?: ReactNode;
  readonly composer?: ReactNode;
  readonly rightSidebar?: ReactNode;
  readonly statusBar?: ReactNode;
  /** The selected chat was opened as a brand-new session, before any saved history exists. */
  readonly newChat?: boolean;
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
      <h1 className="min-w-0 truncate text-sm font-medium">New conversation</h1>
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

/** The header arrow that opens a side panel while it is closed. An open panel's own arrow closes it (see SidebarHeader). */
function SidebarToggle({
  side,
  onToggle,
}: {
  readonly side: "left" | "right";
  readonly onToggle: () => void;
}) {
  const label = side === "left" ? "sessions" : "panels";
  const Icon = side === "left" ? Icons.panelLeft : Icons.panelRight;
  return (
    <Button
      aria-controls={`shell-${label}-sidebar`}
      aria-expanded={false}
      aria-label={`Show ${label} sidebar`}
      aria-keyshortcuts={side === "left" ? "Control+B Meta+B" : "Control+Shift+B Meta+Shift+B"}
      className="text-muted-foreground hover:text-foreground rounded-control grid size-7 place-items-center transition-colors"
      data-shell-sidebar-toggle={side}
      title={`Show ${label} sidebar`}
      variant="ghost"
      onClick={onToggle}
    >
      <Icon aria-hidden="true" className="size-4" />
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
  const action = open ? "Hide" : "Show";
  const actionLabel = `${action} ${label.toLowerCase()} sidebar`;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
      {side === "left" ? (
        <>
          <img alt="" className="size-4 shrink-0" src="/favicon.svg" />
          <span className="text-sm font-medium">omp</span>
          <h2 className="sr-only">{label}</h2>
        </>
      ) : (
        <h2 className="text-sm font-medium">{label}</h2>
      )}
      <Button
        aria-keyshortcuts={side === "left" ? "Control+B Meta+B" : "Control+Shift+B Meta+Shift+B"}
        aria-controls={`shell-${label.toLowerCase()}-sidebar`}
        aria-expanded={open}
        aria-label={actionLabel}
        className="text-muted-foreground hover:text-foreground rounded-control ms-auto -me-1.5 grid size-7 shrink-0 place-items-center transition-colors"
        data-shell-sidebar-collapse={side}
        title={actionLabel}
        variant="ghost"
        onClick={onToggle}
      >
        {side === "left" ? (
          <Icons.panelLeft aria-hidden="true" className="size-4" />
        ) : (
          <Icons.panelRight aria-hidden="true" className="size-4" />
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
  newChat = false,
}: AppShellProps) {
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const { preferences, persistenceStatus, setLeftSidebarWidth, setRightSidebarWidth } =
    useShellPreferences();
  // The desktop layout's open state. The narrow drawers have their own state, so narrowing and then
  // widening again leaves this as it was.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const focusDrawerOnOpen = useRef(false);
  const sessionsSidebarRef = useRef<HTMLElement | null>(null);
  const panelsSidebarRef = useRef<HTMLElement | null>(null);
  const returnFocusSide = useRef<Drawer>(null);
  const leftShown = isNarrow ? drawer === "left" : leftOpen;
  const rightShown = isNarrow ? drawer === "right" : rightOpen;
  const showRightSidebar = useCallback(() => {
    if (isNarrow) setDrawer("right");
    else setRightOpen(true);
  }, [isNarrow]);
  const rightSidebarControl = useMemo<RightSidebar>(
    () => ({ open: rightShown, show: showRightSidebar }),
    [rightShown, showRightSidebar],
  );

  useEffect(() => {
    if (!isNarrow) {
      setDrawer(null);
      returnFocusSide.current = null;
    }
  }, [isNarrow]);

  useEffect(() => {
    if (!drawer) {
      const side = returnFocusSide.current;
      returnFocusSide.current = null;
      if (isNarrow && side) {
        document.querySelector<HTMLButtonElement>(`[data-shell-sidebar-toggle="${side}"]`)?.focus();
      }
      return;
    }

    const shouldFocus = focusDrawerOnOpen.current;
    focusDrawerOnOpen.current = false;
    const sidebar = drawer === "left" ? sessionsSidebarRef.current : panelsSidebarRef.current;
    if (!sidebar) return;
    let focusFrame = 0;
    const focusCollapse = (attempt: number) => {
      if (!shouldFocus) return;
      const collapse = sidebar.querySelector<HTMLButtonElement>("[data-shell-sidebar-collapse]");
      if (collapse && !collapse.closest("[inert]")) {
        collapse.focus();
        if (document.activeElement === collapse || attempt >= 4) return;
      }
      if (attempt < 4) focusFrame = requestAnimationFrame(() => focusCollapse(attempt + 1));
    };
    if (shouldFocus) {
      focusCollapse(0);
      if (document.activeElement !== sidebar.querySelector("[data-shell-sidebar-collapse]"))
        focusFrame = requestAnimationFrame(() => focusCollapse(1));
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          element.getAttribute("aria-hidden") !== "true" &&
          !element.closest("[inert]") &&
          (element.checkVisibility?.() ?? true),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        sidebar.focus();
        return;
      }
      const first =
        sidebar.querySelector<HTMLElement>("[data-shell-sidebar-collapse]") ?? focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !sidebar.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !sidebar.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };

    sidebar.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      sidebar.removeEventListener("keydown", onKeyDown, true);
    };
  }, [drawer, isNarrow]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      if (isEditableTarget(event.target)) return;
      if (event.key === "Escape" && isNarrow && drawer) {
        returnFocusSide.current = drawer;
        setDrawer(null);
        return;
      }

      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "b")
        return;

      event.preventDefault();
      if (event.shiftKey) {
        if (isNarrow)
          setDrawer((current) => {
            focusDrawerOnOpen.current = true;
            if (current === "right") returnFocusSide.current = "right";
            return current === "right" ? null : "right";
          });
        else setRightOpen((open) => !open);
      } else {
        if (isNarrow)
          setDrawer((current) => {
            focusDrawerOnOpen.current = true;
            if (current === "left") returnFocusSide.current = "left";
            return current === "left" ? null : "left";
          });
        else setLeftOpen((open) => !open);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawer, isNarrow]);

  const toggleLeft = () => {
    if (isNarrow) {
      focusDrawerOnOpen.current = true;
      setDrawer("left");
    } else setLeftOpen((open) => !open);
  };
  const toggleRight = () => {
    if (isNarrow) {
      focusDrawerOnOpen.current = true;
      setDrawer("right");
    } else setRightOpen((open) => !open);
  };
  // A side's own arrow closes it. In the narrow layout a drawer closes by leaving no drawer open.
  const closeLeft = () => {
    if (isNarrow) {
      returnFocusSide.current = "left";
      setDrawer(null);
    } else setLeftOpen(false);
  };
  const closeRight = () => {
    if (isNarrow) {
      returnFocusSide.current = "right";
      setDrawer(null);
    } else setRightOpen(false);
  };

  const sidebarTrack = (width: number, open: boolean) =>
    open ? `minmax(0, min(${width}rem, ${MAX_SIDEBAR_VIEWPORT}))` : "minmax(0, 0px)";
  const columns = isNarrow
    ? "minmax(0, 1fr)"
    : `${sidebarTrack(preferences.leftSidebarWidth, leftOpen)} minmax(0, 1fr) ${sidebarTrack(preferences.rightSidebarWidth, rightOpen)}`;
  const sidebarWidth = (side: "left" | "right", open: boolean) => {
    if (!open) return "0";
    if (isNarrow) return `min(18rem, calc(100% - ${spacingTokens.xl}))`;
    return `min(${side === "left" ? preferences.leftSidebarWidth : preferences.rightSidebarWidth}rem, ${MAX_SIDEBAR_VIEWPORT})`;
  };
  const hasDrawer = isNarrow && drawer !== null;

  return (
    <div
      className="relative grid h-dvh min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-background text-foreground transition-[grid-template-columns] duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none"
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
            returnFocusSide.current = drawer;
            setDrawer(null);
          }}
        />
      )}

      <nav
        ref={sessionsSidebarRef}
        aria-hidden={!leftShown}
        aria-label="Sessions"
        className={cn(
          "relative row-span-2 flex min-h-0 min-w-0 flex-col overflow-hidden border-e border-sidebar-border bg-sidebar transition-[width,opacity,visibility] duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none",
          isNarrow && "absolute inset-y-0 start-0 h-full",
          !leftShown && "pointer-events-none invisible opacity-0",
        )}
        data-open={leftShown}
        data-shell-sidebar="left"
        inert={!leftShown}
        id="shell-sessions-sidebar"
        style={{
          width: sidebarWidth("left", leftShown),
          zIndex: isNarrow ? zIndexTokens.overlay : undefined,
        }}
      >
        <SidebarHeader side="left" open={leftShown} onToggle={closeLeft} />
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
        className="group/main relative col-start-1 row-start-1 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden has-[[data-empty-chat='true']]:grid-rows-[auto_minmax(0,1fr)_auto_auto_minmax(0,1fr)] has-[[data-empty-chat='true']]:[&_[data-slot=p3-previous-message-selector]]:hidden has-[[data-empty-chat='true']]:[&_[data-slot=u1-thread-viewport]]:static has-[[data-empty-chat='true']]:[&_[data-slot=u1-thread-footer]>div:last-child]:py-0 has-[[data-empty-chat='true']]:[&_[data-slot=u1-thread-footer]]:static has-[[data-empty-chat='true']]:[&_[data-layout-area]]:bottom-auto has-[[data-empty-chat='true']]:[&_[data-layout-area]]:top-12"
        data-new-chat={newChat || undefined}
        data-shell-main="true"
        id="main-content"
        style={{ gridColumn: isNarrow ? "1" : "2" }}
      >
        <header
          className="flex min-h-12 items-center gap-2 border-b border-border px-4 md:px-5"
          data-shell-region="header"
        >
          {!leftShown && <SidebarToggle side="left" onToggle={toggleLeft} />}
          {threadHeader}
          {!rightShown && <SidebarToggle side="right" onToggle={toggleRight} />}
        </header>
        <div
          aria-hidden="true"
          className="pointer-events-none hidden group-has-[[data-empty-chat='true']]/main:block"
        />
        {/* A labelled region, not role="log": a log is a live region, so every streamed token
            would be announced. U1.8's polite status announces new content instead. */}
        <section
          aria-label="Conversation transcript"
          className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain group-has-[[data-empty-chat='true']]/main:overflow-visible group-has-[[data-empty-chat='true']]/main:[&_[data-slot=u1-thread-viewport]]:overflow-visible"
          data-shell-region="transcript"
        >
          {transcript}
        </section>
        <section
          aria-label="Composer"
          className="shrink-0 bg-background"
          data-shell-region="composer"
        >
          {/* The composer shares the conversation's width, so its edges line up with the messages. */}
          <div className="mx-auto w-full max-w-(--layout-thread-width) px-4 py-3 md:px-6 group-has-[[data-empty-chat='true']]/main:py-0">
            {composer}
          </div>
        </section>
        <div
          aria-hidden="true"
          className="pointer-events-none hidden group-has-[[data-empty-chat='true']]/main:block"
        />
      </main>

      {/* Its own column: a hidden sessions sidebar must not pull this one into the first column. */}
      <aside
        ref={panelsSidebarRef}
        aria-hidden={!rightShown}
        aria-label="Panels"
        className={cn(
          "relative row-span-2 flex min-h-0 min-w-0 flex-col overflow-hidden border-s border-sidebar-border bg-sidebar transition-[width,opacity,visibility] duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none",
          isNarrow && "absolute inset-y-0 end-0 h-full",
          !rightShown && "pointer-events-none invisible opacity-0",
        )}
        data-open={rightShown}
        data-shell-sidebar="right"
        inert={!rightShown}
        id="shell-panels-sidebar"
        style={{
          gridColumn: isNarrow ? undefined : "3",
          width: sidebarWidth("right", rightShown),
          zIndex: isNarrow ? zIndexTokens.overlay : undefined,
        }}
      >
        <SidebarHeader side="right" open={rightShown} onToggle={closeRight} />
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
        className="col-start-1 row-start-2 bg-background"
        data-shell-region="status"
        role="contentinfo"
        style={{ gridColumn: isNarrow ? "1" : "2" }}
      >
        {statusBar ?? <DefaultStatusBar persistenceStatus={persistenceStatus} />}
      </footer>
    </div>
  );
}
