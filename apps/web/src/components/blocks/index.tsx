import type {
  FocusEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  ReactNode,
  Ref,
  UIEventHandler,
} from "react";
import { Button } from "@/components/ui/button";

type PanelRootProps = Omit<
  HTMLAttributes<HTMLElement>,
  "aria-label" | "aria-labelledby" | "children" | "className"
> & {
  readonly [attribute: `data-${string}`]: string | undefined;
};

export interface PanelProps {
  readonly title: string;
  readonly description?: string;
  readonly titleId?: string;
  readonly descriptionId?: string;
  readonly titleRef?: Ref<HTMLHeadingElement>;
  readonly rootRef?: Ref<HTMLElement>;
  readonly className?: string;
  readonly rootProps?: PanelRootProps;
  readonly actions?: ReactNode;
  readonly status?: ReactNode;
  readonly bodyOverlay?: ReactNode;
  readonly bodyRef?: Ref<HTMLDivElement>;
  readonly onBodyScroll?: UIEventHandler<HTMLDivElement>;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function Panel({
  title,
  description,
  titleId,
  descriptionId,
  titleRef,
  rootRef,
  rootProps,
  className,
  actions,
  status,
  bodyOverlay,
  bodyRef,
  onBodyScroll,
  footer,
  children,
}: PanelProps) {
  return (
    <section
      ref={rootRef}
      aria-label={titleId ? undefined : title}
      aria-labelledby={titleId}
      className={`bg-sidebar text-sidebar-foreground flex h-full min-h-0 w-full min-w-0 flex-col outline-none ${className ?? ""}`}
      {...rootProps}
    >
      <header className="border-sidebar-border flex min-h-12 shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2
            ref={titleRef}
            className="truncate text-sm font-semibold tracking-tight"
            id={titleId}
            // Programmatically focusable (never tabbable) when the caller wants to move focus here.
            tabIndex={titleRef ? -1 : undefined}
            title={title}
          >
            {title}
          </h2>
          {description ? (
            <p
              className="text-muted-foreground truncate text-xs"
              id={descriptionId}
              title={description}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions}
      </header>
      {status}
      <div className="relative min-h-0 flex-1">
        {bodyOverlay}
        <div
          ref={bodyRef}
          className="h-full min-h-0 overflow-y-auto overscroll-contain px-3 py-3"
          data-panel-scroll="body"
          onScroll={onBodyScroll}
        >
          {children}
        </div>
      </div>
      {footer ? (
        <footer className="border-sidebar-border shrink-0 border-t px-3 py-2">{footer}</footer>
      ) : null}
    </section>
  );
}

export interface SectionProps {
  readonly heading: string;
  readonly headingId?: string;
  readonly ariaLabel?: string;
  readonly headingTooltip?: string;
  readonly headingLevel?: 2 | 3;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly variant?: "card" | "plain";
  readonly children: ReactNode;
}

export function Section({
  heading,
  headingId,
  ariaLabel,
  headingTooltip,
  headingLevel = 2,
  description,
  actions,
  variant = "card",
  children,
}: SectionProps) {
  const plain = variant === "plain";
  // A card heading wraps: cutting a long section title off would hide it. The plain (list group)
  // heading sits in a narrow column, so it truncates and carries the full text in a tooltip.
  const headingClasses = plain
    ? "text-muted-foreground min-w-0 truncate text-xs font-medium"
    : "min-w-0 text-lg font-semibold tracking-tight";
  const headingTitle = plain ? (headingTooltip ?? heading) : undefined;
  const headingText = (
    <>
      {headingLevel === 3 ? (
        <h3 className={headingClasses} id={headingId} title={headingTitle}>
          {heading}
        </h3>
      ) : (
        <h2 className={headingClasses} id={headingId} title={headingTitle}>
          {heading}
        </h2>
      )}
      {description ? (
        <div
          className={
            plain ? "text-muted-foreground mt-1 text-xs" : "text-muted-foreground mt-1 text-sm"
          }
        >
          {description}
        </div>
      ) : null}
    </>
  );

  return (
    <section
      aria-label={headingId ? undefined : (ariaLabel ?? heading)}
      aria-labelledby={headingId}
      className={
        plain
          ? "mb-3 min-w-0 last:mb-0"
          : "bg-card text-card-foreground rounded-xl border p-5 shadow-sm"
      }
    >
      <header
        className={
          plain
            ? "flex min-w-0 items-center gap-2 px-2 py-1"
            : "mb-5 flex min-w-0 items-start justify-between gap-4"
        }
      >
        <div className="min-w-0 flex-1">{headingText}</div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export interface ListRowProps {
  readonly title: ReactNode;
  readonly titleTooltip?: string;
  readonly detail?: ReactNode;
  readonly detailTooltip?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly tabIndex?: number;
  readonly onSelect?: () => void;
  readonly onFocus?: FocusEventHandler<HTMLButtonElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

/** One row of a list of things to pick from (sessions): selectable when `onSelect` is given. */
export function ListRow({
  title,
  titleTooltip,
  detail,
  detailTooltip,
  leading,
  trailing,
  selected = false,
  disabled = false,
  tabIndex,
  onSelect,
  onFocus,
  onKeyDown,
}: ListRowProps) {
  const titleText = titleTooltip ?? (typeof title === "string" ? title : undefined);
  const detailText = detailTooltip ?? (typeof detail === "string" ? detail : undefined);
  const titleAndDetail = (
    <div className="min-w-0 flex-1">
      <div className="min-w-0 truncate font-medium" title={titleText}>
        {title}
      </div>
      {detail ? (
        <div className="text-muted-foreground min-w-0 truncate text-xs" title={detailText}>
          {detail}
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      aria-disabled={disabled || undefined}
      className="group flex min-w-0 items-start gap-1 rounded-lg text-sm transition-colors hover:bg-sidebar-accent data-[disabled=true]:opacity-60 data-[selected=true]:bg-sidebar-accent"
      data-disabled={disabled ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
    >
      {onSelect ? (
        <button
          aria-disabled={disabled || undefined}
          aria-selected={selected}
          className="flex min-w-0 flex-1 items-start gap-1 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
          disabled={disabled}
          onClick={onSelect}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          role="option"
          tabIndex={tabIndex}
          type="button"
        >
          {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
          {titleAndDetail}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-1 px-2 py-1.5">
          {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
          {titleAndDetail}
        </div>
      )}
      {trailing ? <div className="shrink-0 self-start pt-1">{trailing}</div> : null}
    </div>
  );
}

export interface SettingRowProps {
  readonly title: string;
  readonly description?: string;
  /** A small line under the description, e.g. where the value comes from. */
  readonly detail?: ReactNode;
  /** The control itself, shown beside the label (below it on a narrow screen). */
  readonly children: ReactNode;
}

/** One setting: its label, help text and source on the left, its control on the right. */
export function SettingRow({ title, description, detail, children }: SettingRowProps) {
  return (
    <div className="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,1.25fr)] sm:items-start sm:gap-8">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        {description ? <p className="text-muted-foreground mt-1 text-sm">{description}</p> : null}
        {detail ? <div className="text-muted-foreground mt-2 text-xs">{detail}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export interface ToolbarProps {
  readonly ariaLabel?: string;
  readonly alignment?: "start" | "end";
  readonly children: ReactNode;
}

/**
 * A row of related controls with an accessible name. The name is an `aria-label`, not a visible or
 * sr-only legend, so it adds no text node that repeats a title elsewhere on the page.
 */
export function Toolbar({ ariaLabel, alignment = "start", children }: ToolbarProps) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={`m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 ${alignment === "end" ? "justify-end" : "justify-start"}`}
    >
      {children}
    </fieldset>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly hint?: ReactNode;
  readonly action?: ReactNode;
  readonly variant?: "fill" | "compact";
}

export function EmptyState({ title, hint, action, variant = "fill" }: EmptyStateProps) {
  const compact = variant === "compact";
  return (
    <div
      className={
        compact
          ? "text-muted-foreground flex shrink-0 flex-col gap-2 px-4 py-3 text-sm"
          : "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center"
      }
      role="status"
    >
      <p className={compact ? "text-foreground font-medium" : "text-sm font-medium"} title={title}>
        {title}
      </p>
      {hint ? (
        <p className={compact ? "text-muted-foreground" : "text-muted-foreground text-xs"}>
          {hint}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export interface InlineErrorProps {
  readonly message: string;
  readonly heading?: string;
  readonly onRetry?: () => void | Promise<void>;
  readonly retryLabel?: string;
  readonly variant?: "default" | "compact" | "message";
}

export function InlineError({
  message,
  heading,
  onRetry,
  retryLabel = "Retry",
  variant = "default",
}: InlineErrorProps) {
  return (
    <div
      className={
        variant === "compact"
          ? "flex shrink-0 flex-col items-start gap-2 px-4 py-3 text-sm"
          : variant === "message"
            ? "mt-2 text-sm"
            : "flex flex-col items-start gap-2 p-4 text-sm"
      }
      role="alert"
    >
      {heading ? (
        <p className="text-foreground font-medium" title={heading}>
          {heading}
        </p>
      ) : null}
      {message ? (
        <p className={heading ? "text-muted-foreground" : "text-destructive"} title={message}>
          {message}
        </p>
      ) : null}
      {onRetry ? (
        <Button type="button" size="sm" variant="outline" onClick={() => void onRetry()}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
