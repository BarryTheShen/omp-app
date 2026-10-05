import type { ReactNode } from "react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/shell/use-media-query";
import { Icons } from "@/tokens";
import type { PanelLifecycle, PanelOpenReason, PanelShellProps } from "./contract";
import { usePanelFocus } from "./focus";
import { usePanelScroll } from "./scroll";

export interface PanelShellViewProps extends Omit<PanelShellProps<ReactNode>, "onOpenChange"> {
  readonly actions?: ReactNode;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly onRetry?: () => void | Promise<void>;
  readonly className?: string;
}

function lifecycleLabel(lifecycle: PanelLifecycle): string | null {
  switch (lifecycle) {
    case "loading":
      return "Loading";
    case "updating":
      return "Updating";
    case "empty":
      return "Nothing here yet";
    case "unavailable":
      return "Unavailable";
    case "error":
      return "Unable to load this panel";
    default:
      return null;
  }
}

function StateNotice({
  lifecycle,
  message,
  onRetry,
}: {
  readonly lifecycle: PanelLifecycle;
  readonly message?: string;
  readonly onRetry?: () => void | Promise<void>;
}) {
  const label = lifecycleLabel(lifecycle);
  if (!label) return null;
  const role = lifecycle === "error" ? "alert" : "status";
  return (
    <div
      className="text-muted-foreground flex shrink-0 flex-col gap-2 px-4 py-3 text-sm"
      role={role}
    >
      <span className="font-medium text-foreground">{label}</span>
      {message && <span>{message}</span>}
      {lifecycle === "error" && onRetry && (
        <Button className="self-start" size="sm" variant="outline" onClick={() => void onRetry()}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * U5's non-modal panel surface. U0.3 owns the right-sidebar/drawer mount; this component owns only
 * panel header/lifecycle/focus/scroll grammar and never creates a second overlay or todo store.
 */
export function PanelShell({
  state,
  invokingFocus,
  restoreFocus,
  toolbar,
  body,
  footer,
  actions,
  onOpenChange,
  onRetry,
  className,
}: PanelShellViewProps) {
  const headingId = useId();
  const descriptionId = `${headingId}-description`;
  const narrow = useMediaQuery("(max-width: 48rem)");
  const { refs: scrollRefs, state: scrollState } = usePanelScroll(body);
  const focus = usePanelFocus({
    open: state.open,
    invokingFocus,
    restoreFocus,
    onEscape: () => onOpenChange(false, "escape"),
  });
  const errorMessage =
    state.error?.message ??
    (state.lifecycle === "unavailable" ? "This capability is unavailable." : undefined);
  const bodyStatus = state.lifecycle === "loading" || state.lifecycle === "updating";
  const pendingUpdates = Math.max(state.pendingUpdates, scrollState.pendingUpdates);

  return (
    <section
      ref={focus.panelRef}
      aria-busy={bodyStatus}
      aria-describedby={state.description ? descriptionId : undefined}
      aria-hidden={!state.open}
      aria-labelledby={headingId}
      className={`bg-sidebar text-sidebar-foreground flex h-full min-h-0 w-full min-w-0 flex-col outline-none ${className ?? ""}`}
      data-panel-layout={narrow ? "drawer" : "sidebar"}
      data-panel-lifecycle={state.lifecycle}
      data-panel-open={state.open ? "true" : "false"}
      hidden={!state.open}
      onKeyDown={focus.onKeyDown}
    >
      <header className="border-sidebar-border flex min-h-12 shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2
            ref={focus.headingRef}
            className="truncate text-sm font-semibold tracking-tight"
            id={headingId}
            tabIndex={-1}
          >
            {state.title}
          </h2>
          {state.description && (
            <p className="text-muted-foreground truncate text-xs" id={descriptionId}>
              {state.description}
            </p>
          )}
        </div>
        {toolbar}
        {actions}
        <Button
          aria-label={`Close ${state.title}`}
          size="icon-sm"
          title={`Close ${state.title}`}
          variant="ghost"
          onClick={() => onOpenChange(false, "close-button")}
        >
          <Icons.close aria-hidden="true" />
        </Button>
      </header>

      <StateNotice lifecycle={state.lifecycle} message={errorMessage} onRetry={onRetry} />

      <div className="relative min-h-0 flex-1">
        {pendingUpdates > 0 && !scrollState.atBottom && (
          <Button
            aria-label="Jump to latest panel updates"
            className="absolute top-2 right-3 z-10 shadow-sm"
            size="sm"
            variant="outline"
            onClick={scrollRefs.jumpToLatest}
          >
            <Icons.chevronDown aria-hidden="true" />
            New updates
          </Button>
        )}
        <div
          ref={scrollRefs.bodyRef}
          className="h-full min-h-0 overflow-y-auto overscroll-contain px-3 py-3"
          data-panel-scroll="body"
          onScroll={scrollRefs.onScroll}
        >
          {body}
        </div>
      </div>
      {footer && (
        <footer className="border-sidebar-border shrink-0 border-t px-3 py-2">{footer}</footer>
      )}
    </section>
  );
}
