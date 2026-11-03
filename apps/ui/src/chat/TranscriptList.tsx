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
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { useFollowTrace } from "../perf/followTrace";
import { usePhone } from "../phone";
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

/**
 * A first guess at a row's height; every row is measured once drawn. A guess too large is harmless at the end, where the
 * view stops at the real end; one too small leaves the view short of it, as near the end counts as at it (`AT_END_PX`).
 */
const ESTIMATED_ROW_PX = 72;

/**
 * The height a row not measured yet starts at. A reply's saved entry takes its stream's place with the same text, and
 * drawn at the guess for a frame it moved the view (211 px short at the end of a reply): it starts at the stream's
 * measured height instead, kept until it is measured itself. Any other row starts at the guess. `measured` is TanStack's
 * size cache as of the last render, which still holds the stream.
 */
function useFirstHeights(
  rows: readonly TranscriptRow[],
  measured: RefObject<ReadonlyMap<unknown, number>>,
): (index: number) => number {
  const last = useRef<{
    rows: readonly TranscriptRow[];
    placed: readonly Pick<TranscriptRow, "key" | "kind">[];
  } | null>(null);
  const inherited = useRef(new Map<string, number>());
  if (last.current?.rows !== rows) {
    const before = last.current?.placed ?? [];
    const now = new Set(rows.map((row) => row.key));
    rows.forEach((row, index) => {
      const was = before[index];
      if (was?.kind !== "stream" || row.kind !== "entry" || now.has(was.key)) return;
      if (measured.current.has(row.key)) return;
      const size = measured.current.get(was.key);
      if (size !== undefined) inherited.current.set(row.key, size);
    });
    for (const key of [...inherited.current.keys()])
      if (!now.has(key) || measured.current.has(key)) inherited.current.delete(key);
    last.current = { rows, placed: rows.map(({ key, kind }) => ({ key, kind })) };
  }
  return (index) => {
    const row = rows[index];
    return (row === undefined ? undefined : inherited.current.get(row.key)) ?? ESTIMATED_ROW_PX;
  };
}

/**
 * Which resized rows move the scroll position with them, so that the line being read stays where it is. TanStack's
 * rule, read against the layout as it is now:
 * - A row measured for the first time moves it when the row starts above the top of the view: its estimate was wrong
 *   above the line being read. That includes a row across the top edge: older entries that land while the first row is
 *   read put a new row in the space above it, and its height pushed the first row down by the difference (165 px).
 * - A row measured again moves it only when it lies wholly above the view, and not while the reader scrolls up: a row
 *   across the top edge changed below the part being read.
 *
 * TanStack reads the row's place from a cache that an earlier row in the same batch of measurements may have made stale
 * (its correction moved the scroll position and the rows after it), which moved the line read by 332 px in WebKit.
 * Here `getVirtualItems()` rebuilds the places first; `measurementsCache` then holds the layout's places, as
 * `scrollOffset` is one (the drawn places differ while a correction is held: each row shifted back by the held amount).
 */
function movesView(
  item: VirtualItem,
  _delta: number,
  instance: Virtualizer<HTMLDivElement, Element>,
): boolean {
  instance.getVirtualItems();
  const row = instance.measurementsCache[item.index] ?? item;
  const top = instance.scrollOffset ?? 0;
  if (!instance.itemSizeCache.has(item.key)) return row.start < top;
  return row.end <= top && instance.scrollDirection !== "backward";
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
): RefObject<boolean> {
  const [, render] = useReducer((count: number) => count + 1, 0);
  /** The hold, as the follow trace reads it. */
  const holding = useRef(false);
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
    const setReading = (value: boolean): void => {
      reading = value;
      holding.current = value;
    };
    /** The element scrolled since that wheel or key. */
    let moved = false;
    let idle = 0;
    const input = (): void => {
      setReading(true);
      moved = false;
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        if (!reading || moved) return;
        setReading(false);
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
      if (reading && moved && !instance.isScrolling) setReading(false);
      return canWrite() && !reading;
    };
    return () => {
      window.clearTimeout(idle);
      setReading(false);
      element.removeEventListener("wheel", input);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("scroll", onScroll);
      internals._canWriteScroll = canWrite;
    };
  }, [scrollRef, instance]);
  return holding;
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

/** How long after the reader's wheel, touch, scroll key or scrollbar press a scroll still counts as the reader's. */
const READER_SCROLL_MS = 1_000;

/**
 * Keeps a reader who follows the latest output at the end (#2778). Following is the reader's own choice: it changes
 * only with a scroll the reader makes (a wheel, a touch, a scroll key, the scrollbar), off when it leaves the end and on
 * when it comes back, and with Jump to latest. TanStack's own following decides from how far the view is from the end
 * at the moment output arrives, and that distance is wrong while rows grew and their new height is not measured yet: in
 * the desktop window, without the focus, the view was left 100 to 240 px short for good, with no input. So after every
 * render, a reader who follows and is not at the end is taken there, unless the reader's own scroll or a smooth jump is
 * under way. Returns `follow`, which starts following (Jump to latest), and whether the reader follows, for the trace.
 */
function useFollowLatest(
  scrollRef: RefObject<HTMLDivElement | null>,
  instance: Virtualizer<HTMLDivElement, Element>,
): { readonly follow: () => void; readonly following: RefObject<boolean> } {
  const following = useRef(true);
  const lastReader = useRef(Number.NEGATIVE_INFINITY);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const input = (): void => {
      lastReader.current = performance.now();
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
    // A press on the scrollbar (outside the content box) can drag the view; a press on the content cannot.
    const onPointer = (event: PointerEvent): void => {
      if (event.offsetX > element.clientWidth || event.offsetY > element.clientHeight) input();
    };
    // A scroll soon after the reader's input is the reader's, and so is the rest of that scroll (a fling glides on).
    const onScroll = (): void => {
      if (performance.now() - lastReader.current > READER_SCROLL_MS) return;
      lastReader.current = performance.now();
      following.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <= AT_END_PX;
    };
    const passive = { passive: true } as const;
    element.addEventListener("wheel", input, passive);
    element.addEventListener("touchstart", input, passive);
    element.addEventListener("touchmove", input, passive);
    element.addEventListener("keydown", onKey);
    element.addEventListener("pointerdown", onPointer, passive);
    element.addEventListener("scroll", onScroll, passive);
    return () => {
      element.removeEventListener("wheel", input);
      element.removeEventListener("touchstart", input);
      element.removeEventListener("touchmove", input);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("pointerdown", onPointer);
      element.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef]);

  // After every render: rows added or measured, the box resized, a scroll ended.
  useLayoutEffect(() => {
    if (!following.current || instance.isAtEnd()) return;
    if (performance.now() - lastReader.current < READER_SCROLL_MS) return;
    const state = (instance as unknown as { scrollState?: { behavior?: string } | null })
      .scrollState;
    if (state?.behavior === "smooth") return;
    instance.scrollToEnd();
  });

  const follow = (): void => {
    following.current = true;
  };
  return { follow, following };
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
  const measured = useRef<ReadonlyMap<unknown, number>>(new Map());
  const firstHeight = useFirstHeights(rows, measured);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: firstHeight,
    getItemKey: (index) => rows[index]?.key ?? index,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: AT_END_PX,
    overscan: 6,
    paddingStart: 24,
    paddingEnd: 16,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = movesView;
  measured.current = virtualizer.itemSizeCache;
  const holding = useHoldCorrectionsWhileReading(scrollRef, virtualizer);
  useStayAtEndWhenShorter(scrollRef, virtualizer);
  const { follow, following } = useFollowLatest(scrollRef, virtualizer);
  const atEnd = virtualizer.isAtEnd();
  useFollowTrace(scrollRef, virtualizer, {
    atEnd,
    rows: rows.length,
    working,
    holding,
    following,
  });

  // Start at the latest entry once the first window is there.
  const empty = rows.length === 0;
  useLayoutEffect(() => {
    if (!empty) virtualizer.scrollToEnd();
  }, [virtualizer, empty]);
  // The render that first shows a window is drawn from the top, before the list has moved to the latest entry: its
  // first rows are not the reader near the top, and taking them so read 1 MB of older entries on every open (#2768). One
  // frame on, the move's scroll event has come (a frame's scroll events run before its animation frames).
  const [positioned, setPositioned] = useState(false);
  useEffect(() => {
    if (empty) return;
    const frame = requestAnimationFrame(() => setPositioned(true));
    return () => cancelAnimationFrame(frame);
  }, [empty]);

  const items = virtualizer.getVirtualItems();
  const firstIndex = items[0]?.index;
  useEffect(() => {
    // A window shorter than the screen stays at the top once positioned, so it fills the screen from older entries.
    if (positioned && firstIndex !== undefined && firstIndex < 3 && hasOlder) onNearTop();
  }, [positioned, firstIndex, hasOlder, onNearTop]);

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
                // The row's own key, which a prepend does not shift: the scroll trace follows a row by it.
                data-key={String(item.key)}
                // What the row is: the scroll trace names a row that grows or shrinks by it.
                data-kind={row.kind}
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
      {!empty && !atEnd && (
        // On a phone a round button in the corner, clear of the text being read.
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border-l2 px-3 shadow-md max-sm:right-3 max-sm:left-auto max-sm:size-11 max-sm:translate-x-0 max-sm:px-0"
          aria-label="Jump to latest"
          onClick={() => {
            follow();
            virtualizer.scrollToEnd({ behavior: "smooth" });
          }}
        >
          <ArrowDown />
          <span className="max-sm:sr-only">Jump to latest</span>
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

/** A new chat's first screen: where omp will work, and the keys of the message box (a phone's return key adds a line). */
function Welcome({ folder }: { readonly folder: string }): ReactNode {
  const phone = usePhone();
  const keys: readonly (readonly [string, string])[] = [
    ["/", "commands"],
    ["@", "files"],
    ["!", "shell"],
    ...(phone ? [] : ([["Enter", "send"]] as const)),
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
 * What rows offer: a failed request's Retry, Switch model and the app's own continue after a usage limit, stopping a `!`
 * command, dismissing a notice, and Edit on your messages (only while omp is idle).
 */
export interface RowActions {
  readonly onRetry: () => Promise<void>;
  /** When the app continues the chat by itself after a usage limit (#2781); null when it will not. */
  readonly continuesAt: number | null;
  /** "Don't continue": the chat stays stopped after its usage limit. */
  readonly onDontContinue: () => Promise<void>;
  readonly onSwitchModel: () => void;
  readonly onStopShell: () => Promise<void>;
  readonly onDismissNotice: (id: number) => void;
  /** A shared service's link in the chat was followed (#2788). */
  readonly onShareOpened: (shareId: string) => void;
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
      const message = <EntryRow entry={row.entry} results={results} active={active} host={host} />;
      return text === null ? (
        message
      ) : (
        <MessageActions text={text} onEdit={editable ? () => actions.onEdit(id) : null}>
          {message}
        </MessageActions>
      );
    }
    case "failure":
      return (
        <Row kind="assistant" gutter="">
          <FailureRow
            error={row.error}
            latest={row.latest}
            continuesAt={actions.continuesAt}
            onRetry={actions.onRetry}
            onSwitchModel={actions.onSwitchModel}
            onDontContinue={actions.onDontContinue}
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
          <NoticeRow
            notice={row.notice}
            onDismiss={actions.onDismissNotice}
            onShareOpened={actions.onShareOpened}
          />
        </Row>
      );
  }
}
