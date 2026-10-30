import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { Button } from "@/components/ui/button";
import { ToolCard } from "../vendor/collab-web/components/transcript/ToolCard";
import {
  AssistantBody,
  EntryRow,
  Row,
} from "../vendor/collab-web/components/transcript/Transcript";
import type { ActiveTool } from "../vendor/collab-web/lib/types";
import type { ToolRenderHost } from "../vendor/collab-web/tool-render/types";
import { FailureRow } from "./FailureRow";
import { MessageActions, userText } from "./MessageActions";
import { buildRows, type TranscriptRow, toolResults } from "./rows";
import { NoticeRow, ShellBlock } from "./ShellBlock";
import type { ChatSnapshot } from "./store";

/** A first guess at a row's height; every row is measured once drawn. */
const ESTIMATED_ROW_PX = 72;

/**
 * Which resized rows move the scroll position with them: only rows wholly above the top of the view. TanStack's default
 * also moves it for a row's first measurement when the row only starts above the view; such a row grows below the line
 * being read, so moving the view pushes that line off the screen (332 px in WebKit). The row's place is read from the
 * layout as it is now: `getVirtualItems()` rebuilds it (the scroll position already moved for the rows measured before
 * it in the same batch, and the row moved with them), and `measurementsCache` holds the layout's places, as
 * `scrollOffset` is one; the drawn places differ while a correction is held (each row shifted back by the held amount).
 * A row measured again keeps TanStack's rule: not while the reader scrolls up.
 */
function movesView(
  item: VirtualItem,
  _delta: number,
  instance: Virtualizer<HTMLDivElement, Element>,
): boolean {
  instance.getVirtualItems();
  const row = instance.measurementsCache[item.index] ?? item;
  if (row.end > (instance.scrollOffset ?? 0)) return false;
  return !instance.itemSizeCache.has(item.key) || instance.scrollDirection !== "backward";
}

/** How near the end still counts as at the end: the list then follows new output. */
const AT_END_PX = 80;

/** Keys that scroll the transcript when it has the focus: WebKit animates them, as it does the wheel. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** How long a wheel or a scroll key may go without scrolling before it counts as one at an edge, which moves nothing. */
const NO_SCROLL_MS = 150;

/**
 * Holds the list's position corrections while the reader scrolls with the wheel or the keys, and writes them once the
 * scroll has ended. A correction (for a row above the view measured for the first time) is a `scrollTop` write, and
 * WebKit stops a running scroll animation at such a write (`ScrollAnimator::scrollToPositionWithoutAnimation`): a wheel
 * step in the desktop window fell short by up to two thirds whenever a row above was measured. TanStack already holds
 * corrections while a write cannot land (`_canWriteScroll`, for a touch on iOS): it shows the rows shifted back by the
 * amount held, so the line being read stays put, and writes the whole amount in one paint once a write can land. The
 * reader's own scroll is one of those times here; the list's own writes (following new output, jumping to the end) are
 * not, and neither is a scroll that already ended. A wheel at an edge scrolls nothing: the hold ends after
 * `NO_SCROLL_MS`, and a render writes what it held. The hook is TanStack's own; should a new version drop it, the page
 * says so in the console (which fails every end-to-end spec) and scrolls as it did before.
 */
function useHoldCorrectionsWhileReading(
  scrollRef: RefObject<HTMLDivElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
): void {
  const [, render] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const internals = instance as unknown as { _canWriteScroll?: () => boolean };
    const canWrite = internals._canWriteScroll;
    if (typeof canWrite !== "function") {
      console.error(
        "TanStack Virtual has no _canWriteScroll: the transcript writes its corrections during scrolls again.",
      );
      return;
    }
    /** The reader's wheel or key started a scroll that has not ended yet. */
    let reading = false;
    /** The element scrolled since that wheel or key. */
    let moved = false;
    let idle = 0;
    const input = (): void => {
      reading = true;
      moved = false;
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (!reading || moved) return;
        reading = false;
        render();
      }, NO_SCROLL_MS);
    };
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea") !== null)
      )
        return;
      if (SCROLL_KEYS.has(event.key)) input();
    };
    const onScroll = (): void => {
      if (reading) moved = true;
    };
    element.addEventListener("wheel", input, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("scroll", onScroll, { passive: true });
    // TanStack asks before every correction and flush; a scroll that moved and then ended ends the hold.
    internals._canWriteScroll = () => {
      if (reading && moved && !instance.isScrolling) reading = false;
      return canWrite() && !reading;
    };
    return () => {
      window.clearTimeout(idle);
      element.removeEventListener("wheel", input);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("scroll", onScroll);
      internals._canWriteScroll = canWrite;
    };
  }, [scrollRef, instance]);
}

/**
 * Keeps a reader who is at the end at the end when the list gets shorter (the working row and the box grow as the chat
 * goes live): the list follows output that grows, not a view that shrinks.
 */
function useStayAtEndWhenShorter(
  scrollRef: RefObject<HTMLDivElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
): void {
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const before = height;
      height = element.clientHeight;
      if (height >= before) return;
      if (element.scrollHeight - element.scrollTop - before <= AT_END_PX) instance.scrollToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, instance]);
}

/**
 * The transcript as a virtual list in TanStack Virtual's chat mode (https://tanstack.com/virtual/latest/docs/chat.md):
 * anchored to the end, it follows new output only while the reader is at the end, keeps the reader's place when older
 * entries are added on top, and draws only the rows on screen. The rows are collab-web's.
 */
export function TranscriptList({
  snapshot,
  onNearTop,
  actions,
  welcome,
  host,
  label = "Transcript",
}: {
  readonly snapshot: ChatSnapshot;
  readonly onNearTop: () => void;
  readonly actions: RowActions;
  /** A new chat's greeting while it is empty; null for a saved chat, which shows its entries as they load. */
  readonly welcome: { readonly folder: string } | null;
  /** What the tool cards may open (a task card's subagents, in the Agent Hub). */
  readonly host?: ToolRenderHost;
  /** The list's name for a screen reader. */
  readonly label?: string;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { entries, stream, streamDone, activeTools, working, hasOlder, shell, notices } = snapshot;
  const rows = useMemo(
    () =>
      buildRows({ entries, stream, streamDone, activeTools, working, shell, notices, hasOlder }),
    [entries, stream, streamDone, activeTools, working, shell, notices, hasOlder],
  );
  const results = useMemo(() => toolResults(entries), [entries]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: AT_END_PX,
    overscan: 6,
    paddingStart: 24,
    paddingEnd: 16,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = movesView;
  useHoldCorrectionsWhileReading(scrollRef, virtualizer);
  useStayAtEndWhenShorter(scrollRef, virtualizer);

  // Start at the latest entry once the first window is there.
  const empty = rows.length === 0;
  useLayoutEffect(() => {
    if (!empty) virtualizer.scrollToEnd();
  }, [virtualizer, empty]);

  const items = virtualizer.getVirtualItems();
  const firstIndex = items[0]?.index;
  useEffect(() => {
    if (firstIndex !== undefined && firstIndex < 3 && hasOlder) onNearTop();
  }, [firstIndex, hasOlder, onNearTop]);

  return (
    <div className="relative min-h-0 flex-1">
      <section ref={scrollRef} className="tr-root tl-scroll" aria-label={label}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="tl-item group/msg absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <RowView
                  row={row}
                  results={results}
                  active={activeTools}
                  actions={actions}
                  host={host}
                />
              </div>
            );
          })}
        </div>
      </section>
      {empty && welcome !== null && <Welcome folder={welcome.folder} />}
      {!empty && !virtualizer.isAtEnd() && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border-l2 px-3 shadow-md"
          onClick={() => virtualizer.scrollToEnd({ behavior: "smooth" })}
        >
          <ArrowDown />
          Jump to latest
        </Button>
      )}
    </div>
  );
}

/** The end of a folder's path, which names it: `…/projects/omp-app` for a long one. */
function folderTail(folder: string): string {
  const parts = folder.split("/").filter((part) => part !== "");
  return parts.length <= 2 ? folder : `…/${parts.slice(-2).join("/")}`;
}

/** A new chat's first screen: where omp will work, and the keys of the message box. */
function Welcome({ folder }: { readonly folder: string }): ReactNode {
  const keys: readonly (readonly [string, string])[] = [
    ["/", "commands"],
    ["@", "files"],
    ["!", "shell"],
    ["Enter", "send"],
  ];
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-9 opacity-90" />
      <p className="text-base font-medium text-t1">What are we working on?</p>
      <p className="max-w-full truncate font-mono text-xs text-t3">{folderTail(folder)}</p>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-t3">
        {keys.map(([key, label]) => (
          <li key={key}>
            <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px] text-t2">
              {key}
            </kbd>{" "}
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What rows offer: a failed request's Retry and Switch model, stopping a `!` command, dismissing a notice, and Edit on
 * your messages (only while omp is idle).
 */
export interface RowActions {
  readonly onRetry: () => Promise<void>;
  readonly onSwitchModel: () => void;
  readonly onStopShell: () => Promise<void>;
  readonly onDismissNotice: (id: number) => void;
  readonly onEdit: (entryId: string) => void;
  readonly canEdit: boolean;
}

function RowView({
  row,
  results,
  active,
  actions,
  host,
}: {
  readonly row: TranscriptRow;
  readonly results: ReadonlyMap<string, ToolResultMessage>;
  readonly active: ReadonlyMap<string, ActiveTool>;
  readonly actions: RowActions;
  readonly host: ToolRenderHost | undefined;
}): ReactNode {
  switch (row.kind) {
    case "entry": {
      const text = userText(row.entry);
      // A message read from the stream has no id of omp's until the file is read back after the turn.
      const editable = actions.canEdit && !row.entry.id.startsWith("live-");
      const { id } = row.entry;
      return (
        <>
          <EntryRow entry={row.entry} results={results} active={active} host={host} />
          {text !== null && (
            <MessageActions text={text} onEdit={editable ? () => actions.onEdit(id) : null} />
          )}
        </>
      );
    }
    case "failure":
      return (
        <Row kind="assistant" gutter="">
          <FailureRow
            error={row.error}
            latest={row.latest}
            onRetry={actions.onRetry}
            onSwitchModel={actions.onSwitchModel}
          />
        </Row>
      );
    case "stream":
      return (
        <Row kind="assistant" gutter="agent">
          <AssistantBody
            message={row.message}
            results={results}
            active={active}
            pending={row.pending}
            host={host}
          />
        </Row>
      );
    case "tools":
      return (
        <Row kind="assistant" gutter={row.first ? "agent" : ""}>
          {row.tools.map((tool) => (
            <ToolCard
              key={tool.toolCallId}
              toolCallId={tool.toolCallId}
              name={tool.toolName}
              intent={tool.intent}
              args={tool.args}
              running
              partialResult={tool.partialResult}
              host={host}
            />
          ))}
        </Row>
      );
    case "working":
      return (
        <Row kind="assistant" gutter="agent">
          <div className="tr-shimmer">thinking…</div>
        </Row>
      );
    case "shell":
      return (
        <Row kind="assistant" gutter="">
          <ShellBlock run={row.run} onStop={actions.onStopShell} />
        </Row>
      );
    case "notice":
      return (
        <Row kind="assistant" gutter="">
          <NoticeRow notice={row.notice} onDismiss={actions.onDismissNotice} />
        </Row>
      );
  }
}
