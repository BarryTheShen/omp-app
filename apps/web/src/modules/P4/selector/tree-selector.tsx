import type { EntryId } from "@omp-app/contracts";
import {
  type KeyboardEvent,
  memo,
  type UIEvent,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EmptyState, InlineError, ListRow, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icons } from "@/tokens";
import type { P4TreeSelectorActions } from "./tree-selector-controller";
import type { P4TreeSelectorRowModel, P4TreeSelectorViewModel } from "./tree-selector-model";
import { formatTreeTimestamp } from "./tree-selector-model";

/** A row is `h-14` (3.5rem). The window is measured in rem so it stays right at any root font size. */
const TREE_ROW_REM = 3.5;
const TREE_WINDOW_SIZE = 40;
const TREE_OVERSCAN = 8;

export interface P4TreeSelectorViewProps {
  readonly model: P4TreeSelectorViewModel;
  readonly activeEntryId: EntryId | null;
  readonly actions: P4TreeSelectorActions;
  readonly showStateMessages?: boolean;
}

function rootFontPx(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

function windowStartFor(scrollTop: number): number {
  return Math.max(0, Math.floor(scrollTop / (TREE_ROW_REM * rootFontPx())) - TREE_OVERSCAN);
}

/** Scrolls the least needed to show a row; returns the window start that renders it. */
function revealRow(tree: HTMLDivElement, index: number): number {
  const rowHeight = TREE_ROW_REM * rootFontPx();
  const paddingTop = Number.parseFloat(getComputedStyle(tree).paddingTop) || 0;
  const rowTop = paddingTop + index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < tree.scrollTop) {
    tree.scrollTop = rowTop;
  } else if (rowBottom > tree.scrollTop + tree.clientHeight) {
    tree.scrollTop = rowBottom - tree.clientHeight;
  }
  return windowStartFor(tree.scrollTop);
}

function StatusNotice({
  model,
  actions,
}: {
  readonly model: P4TreeSelectorViewModel;
  readonly actions: P4TreeSelectorActions;
}) {
  const status = model.status;
  if (!status) return null;
  if (status.kind === "error") {
    return (
      <InlineError
        heading="Couldn't load conversation history"
        message={status.message}
        onRetry={status.retryable ? actions.onRetry : undefined}
        variant="compact"
      />
    );
  }
  return <EmptyState title={status.message} variant="compact" />;
}

const accessibleDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

function formatAccessibleTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : accessibleDateTimeFormat.format(date);
}

interface TreeItemViewProps {
  readonly row: P4TreeSelectorRowModel;
  readonly tabIndex: number;
  readonly treeId: string;
  readonly actions: Pick<
    P4TreeSelectorActions,
    "onRowFocus" | "onRowKeyDown" | "onSelectEntry" | "registerRowRef"
  >;
}

const TreeItemView = memo(function TreeItemView({
  row,
  tabIndex,
  treeId,
  actions,
}: TreeItemViewProps) {
  const timestamp = formatTreeTimestamp(row.timestamp);
  const accessibleTimestamp = formatAccessibleTimestamp(row.timestamp);
  const messageName =
    row.role === "You" ? "Your message" : row.role === "Assistant" ? "Assistant message" : row.role;
  const excerpt = row.preview.trim().replace(/\s+/g, " ");
  const shortExcerpt = excerpt.length > 144 ? `${excerpt.slice(0, 143).trimEnd()}…` : excerpt;
  const ariaLabel = [
    messageName,
    shortExcerpt,
    `from ${accessibleTimestamp}`,
    row.currentLeaf ? "current message" : "",
    row.label ? `label ${row.label.text ?? "No label text"}, read only` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const titleTooltip = [
    row.role,
    row.currentLeaf ? "current message" : "",
    row.label ? `label ${row.label.text ?? ""}`.trim() : "",
  ]
    .filter(Boolean)
    .join(", ");
  const registerRef = useCallback(
    (element: HTMLDivElement | null) => actions.registerRowRef(row.entryId, element),
    [actions.registerRowRef, row.entryId],
  );
  const selectEntry = useCallback(
    () => actions.onSelectEntry(row.entryId),
    [actions.onSelectEntry, row.entryId],
  );
  const rowFocus = useCallback(
    () => actions.onRowFocus(row.entryId),
    [actions.onRowFocus, row.entryId],
  );
  const rowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => actions.onRowKeyDown(row.entryId, event),
    [actions.onRowKeyDown, row.entryId],
  );

  return (
    <div
      ref={registerRef}
      aria-expanded={row.hasVisibleChildren ? !row.collapsed : undefined}
      aria-label={ariaLabel}
      aria-level={row.depth + 1}
      aria-posinset={row.position + 1}
      aria-selected={row.selected}
      aria-setsize={row.siblingCount}
      className="h-14 min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-tree-entry-id={row.entryId}
      id={`${treeId}-item-${row.entryId}`}
      role="treeitem"
      style={
        row.depth === 0
          ? undefined
          : { paddingInlineStart: `calc(${Math.min(row.depth, 8)} * var(--space-md))` }
      }
      tabIndex={tabIndex}
      title={timestamp}
      onClick={selectEntry}
      onFocus={rowFocus}
      onKeyDown={rowKeyDown}
    >
      <ListRow
        detail={shortExcerpt}
        detailTooltip={shortExcerpt}
        leading={
          row.hasVisibleChildren ? (
            <Icons.chevronRight
              aria-hidden="true"
              className={`mt-0.5 size-4 shrink-0 text-muted-foreground ${row.collapsed ? "" : "rotate-90"}`}
            />
          ) : (
            <span aria-hidden="true" className="size-4 shrink-0" />
          )
        }
        selected={row.selected}
        title={
          <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{row.role}</span>
            {row.currentLeaf ? (
              <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-normal text-primary">
                Current message
              </span>
            ) : null}
            {row.label ? (
              <span className="border-warning/40 bg-warning-surface text-warning-surface-foreground max-w-40 min-w-0 truncate rounded-md border px-1.5 py-0.5 text-xs font-normal">
                {row.label.text ?? "Label"}
              </span>
            ) : null}
          </span>
        }
        titleTooltip={titleTooltip}
      />
    </div>
  );
});

export function P4TreeSelectorView({
  model,
  activeEntryId,
  actions,
  showStateMessages = true,
}: P4TreeSelectorViewProps) {
  const treeId = useId();
  const searchId = `${treeId}-search`;
  const treeRef = useRef<HTMLDivElement | null>(null);
  const previousList = useRef({
    query: model.filter.query,
    showLabels: model.filter.showLabels,
    showAll: model.showAllEntries,
    threadId: model.threadId,
  });
  const revealedEntryId = useRef<EntryId | null>(null);
  const [firstRowIndex, setFirstRowIndex] = useState(0);
  const startIndex = Math.min(firstRowIndex, Math.max(0, model.rows.length - TREE_WINDOW_SIZE));
  const endIndex = Math.min(model.rows.length, startIndex + TREE_WINDOW_SIZE);
  const visibleRows = model.rows.slice(startIndex, endIndex);
  const onTreeScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setFirstRowIndex(windowStartFor(event.currentTarget.scrollTop));
  }, []);

  // A changed list starts at the top; the active row is then brought back into view. Passive
  // updates leave the list where it is, and focus is never moved here.
  useLayoutEffect(() => {
    const previous = previousList.current;
    const listChanged =
      previous.query !== model.filter.query ||
      previous.showLabels !== model.filter.showLabels ||
      previous.showAll !== model.showAllEntries ||
      previous.threadId !== model.threadId;
    previousList.current = {
      query: model.filter.query,
      showLabels: model.filter.showLabels,
      showAll: model.showAllEntries,
      threadId: model.threadId,
    };
    const tree = treeRef.current;
    if (!tree) {
      // No list is rendered, so the next one starts at its top and is revealed again.
      setFirstRowIndex(0);
      revealedEntryId.current = null;
      return;
    }
    if (listChanged) {
      tree.scrollTop = 0;
      setFirstRowIndex(0);
      revealedEntryId.current = null;
    }
    if (activeEntryId === null || revealedEntryId.current === activeEntryId) return;
    const index = model.rows.findIndex((row) => row.entryId === activeEntryId);
    if (index < 0) return;
    revealedEntryId.current = activeEntryId;
    setFirstRowIndex(revealRow(tree, index));
  }, [
    activeEntryId,
    model.filter.query,
    model.filter.showLabels,
    model.rows,
    model.showAllEntries,
    model.threadId,
  ]);

  if (!model.hasTree) {
    return showStateMessages ? <StatusNotice actions={actions} model={model} /> : null;
  }

  const listEmptyTitle = model.noResultsMessage ?? model.emptyListMessage;

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col gap-3">
      {showStateMessages && model.status ? <StatusNotice actions={actions} model={model} /> : null}
      <Toolbar ariaLabel="Conversation message filters">
        <label className="sr-only" htmlFor={searchId}>
          Search conversation messages
        </label>
        <Input
          className="min-w-0 flex-1"
          id={searchId}
          placeholder="Search messages"
          type="search"
          value={model.filter.query}
          onChange={(event) => actions.onFilterInput(event.currentTarget.value)}
        />
        {model.hasLabels ? (
          <Button
            aria-pressed={model.filter.showLabels}
            size="sm"
            type="button"
            variant={model.filter.showLabels ? "secondary" : "outline"}
            onClick={actions.onToggleLabels}
          >
            {model.filter.showLabels ? "Hide labels" : "Show labels"}
          </Button>
        ) : null}
      </Toolbar>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" className="text-muted-foreground text-xs" role="status">
          {model.resultSummary}
        </p>
        <Button
          aria-pressed={model.showAllEntries}
          size="sm"
          type="button"
          variant={model.showAllEntries ? "secondary" : "outline"}
          onClick={actions.onToggleShowAllEntries}
        >
          Show all entries
        </Button>
      </div>
      {model.labelsNotice ? (
        <p className="text-muted-foreground text-xs">{model.labelsNotice}</p>
      ) : null}
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-4 @lg:grid-cols-2 @lg:grid-rows-1">
        {listEmptyTitle ? (
          <EmptyState title={listEmptyTitle} variant="compact" />
        ) : (
          <div
            ref={treeRef}
            aria-label="Conversation messages"
            className="min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-lg border border-border p-1"
            role="tree"
            data-focus-scope="tree"
            onScroll={onTreeScroll}
          >
            {startIndex > 0 ? (
              <div aria-hidden="true" style={{ height: `${startIndex * TREE_ROW_REM}rem` }} />
            ) : null}
            {visibleRows.map((row) => (
              <TreeItemView
                key={row.entryId}
                actions={actions}
                row={row}
                tabIndex={row.entryId === activeEntryId ? 0 : -1}
                treeId={treeId}
              />
            ))}
            {endIndex < model.rows.length ? (
              <div
                aria-hidden="true"
                style={{ height: `${(model.rows.length - endIndex) * TREE_ROW_REM}rem` }}
              />
            ) : null}
          </div>
        )}
        {/* The preview is bounded: a long message scrolls inside its own box, never over the list. */}
        <div className="min-h-0 max-h-56 overflow-y-auto @lg:max-h-none">
          <Section heading="Message preview" headingLevel={3}>
            {model.preview ? (
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-muted-foreground text-sm">{model.preview.role}</span>
                  {model.preview.currentLeaf ? (
                    <span className="text-primary text-xs">Current message</span>
                  ) : null}
                </div>
                <time
                  className="text-muted-foreground block break-all text-xs"
                  dateTime={model.preview.timestamp}
                >
                  {formatTreeTimestamp(model.preview.timestamp)}
                </time>
                {model.preview.label ? (
                  <p className="text-muted-foreground break-words text-xs">
                    Label: {model.preview.label.text ?? "No label text"} · Read-only
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-sm">{model.preview.text}</p>
              </div>
            ) : (
              <EmptyState title="Choose a message to preview it." variant="compact" />
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
