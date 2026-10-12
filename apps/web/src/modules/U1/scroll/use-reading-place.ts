import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { captureVisibleMessageAnchor, retainVisibleMessageAnchor } from "./anchor";
import {
  clearReadingPlace,
  findMessageRow,
  isViewportAtBottom,
  MAX_OLDER_PAGES,
  nextResumeStep,
  type ReadingPlace,
  rowStoreKey,
  saveReadingPlace,
  transcriptCaughtUp,
  whenViewportSettled,
} from "./reading-place";

/** How long the restored place is held while the rows above it take their real heights. */
const SETTLE_MS = 2_000;
/** Any of these means the reader is steering: from then on the viewport is theirs. */
const READER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export interface ReadingPlaceOptions {
  readonly viewportRef: RefObject<HTMLElement | null>;
  /** The chat on screen. Without it the reader's place is neither saved nor restored. */
  readonly threadId: string | undefined;
  /** The place this page load returns to, set only by the reload that reopens the chat. */
  readonly resumeAt: ReadingPlace | null;
  /** The chat's history is still being read. */
  readonly historyLoading: boolean;
  /** Message ids in order: a change means rows arrived or left. */
  readonly messageOrder: readonly string[];
  readonly hasOlder: boolean;
  readonly loadOlder: (() => Promise<void>) | undefined;
}

export interface ReadingPlaceState {
  /** The viewport opens at the reader's place, so assistant-ui must not scroll it to the newest message. */
  readonly startsAtPlace: boolean;
  /** The place is not settled yet: the reader must not be pulled to the bottom meanwhile. */
  readonly resuming: boolean;
}

/** Where a resume is: placing the saved message, keeping it in place while the rows settle, or done. */
type Phase = "placing" | "settling" | "done";

/** Older-history paging while the saved message is not loaded. */
interface Paging {
  /** Older pages started during this resume. */
  readonly pages: number;
  readonly status: "idle" | "loading" | "settled" | "failed";
  /** The row count when the page started: a settled page that added none has nothing more to offer. */
  readonly rowsBefore: number;
}

/** The rows and paging a wait for the transcript to settle was started with. */
interface Settled {
  readonly order: readonly string[];
  readonly paging: Paging;
}

const NO_PAGING: Paging = { pages: 0, status: "idle", rowsBefore: 0 };

/** The same message ids in the same order, however the array holding them was made. */
function sameRows(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * A reload that reopens the chat returns the viewport to the message the reader was reading. Without this,
 * assistant-ui scrolls to the newest message as the history arrives. Every other open starts at the bottom,
 * as before. The place is kept on its message while the rows above it take their real heights, saved while
 * the reader scrolls, and cleared when they are at the bottom.
 */
export function useReadingPlace(options: ReadingPlaceOptions): ReadingPlaceState {
  const { viewportRef, threadId, resumeAt, historyLoading, messageOrder, hasOlder, loadOlder } =
    options;
  const [target] = useState<ReadingPlace | null>(() =>
    resumeAt !== null && threadId !== undefined && resumeAt.threadId === threadId ? resumeAt : null,
  );
  const [phase, setPhase] = useState<Phase>(target === null ? "done" : "placing");
  const [paging, setPaging] = useState<Paging>(NO_PAGING);
  // The rows and paging a wait for the transcript has finished with: a decision is taken against these only.
  const [settledFor, setSettledFor] = useState<Settled | null>(null);
  const pendingWait = useRef<{ readonly settled: Settled; readonly cancel: () => void } | null>(
    null,
  );

  useEffect(
    () => () => {
      pendingWait.current?.cancel();
    },
    [],
  );

  useLayoutEffect(() => {
    if (target === null || phase !== "placing") return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    // The initial load is still putting rows in place: nothing is placed against a half-loaded transcript.
    if (historyLoading) return;
    const row = findMessageRow(viewport, target.messageId);
    if (row !== null) {
      pendingWait.current?.cancel();
      pendingWait.current = null;
      retainVisibleMessageAnchor(viewport, {
        row,
        offset: target.offset,
        scrollTop: viewport.scrollTop,
      });
      setPhase("settling");
      return;
    }
    const canLoadOlder =
      hasOlder &&
      loadOlder !== undefined &&
      paging.status !== "failed" &&
      paging.pages < MAX_OLDER_PAGES &&
      (paging.status !== "settled" || messageOrder.length > paging.rowsBefore);
    const step = nextResumeStep({
      historyLoading: false,
      rowLoaded: false,
      canLoadOlder,
      pageInFlight: paging.status === "loading",
    });
    if (step === "wait") return;
    // A row missing right after a change may simply not be drawn yet: decide once the transcript has caught up.
    const ready =
      settledFor !== null &&
      sameRows(settledFor.order, messageOrder) &&
      settledFor.paging === paging;
    if (!ready) {
      const pending = pendingWait.current;
      if (
        pending === null ||
        !sameRows(pending.settled.order, messageOrder) ||
        pending.settled.paging !== paging
      ) {
        pending?.cancel();
        const settled: Settled = { order: messageOrder, paging };
        pendingWait.current = {
          settled,
          cancel: whenViewportSettled(
            viewport,
            () => transcriptCaughtUp(viewport, messageOrder),
            () => {
              pendingWait.current = null;
              setSettledFor(settled);
            },
          ),
        };
      }
      return;
    }
    setSettledFor(null);
    if (step === "bottom") {
      viewport.scrollTop = viewport.scrollHeight;
      setPhase("done");
      return;
    }
    if (loadOlder === undefined) return;
    setPaging({ pages: paging.pages + 1, status: "loading", rowsBefore: messageOrder.length });
    loadOlder()
      .then(() =>
        setPaging((previous) =>
          previous.status === "loading" ? { ...previous, status: "settled" } : previous,
        ),
      )
      // The page could not be read: the reader opens at the newest message instead of waiting forever.
      .catch(() => setPaging((previous) => ({ ...previous, status: "failed" })));
  }, [
    target,
    phase,
    viewportRef,
    historyLoading,
    messageOrder,
    hasOlder,
    loadOlder,
    paging,
    settledFor,
  ]);

  // Once placed, the place is kept on its message while the rows above it settle, until the reader steers.
  useEffect(() => {
    if (target === null || phase !== "settling") return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const keepPlace = (): void => {
      const row = findMessageRow(viewport, target.messageId);
      if (row !== null) {
        retainVisibleMessageAnchor(viewport, {
          row,
          offset: target.offset,
          scrollTop: viewport.scrollTop,
        });
      }
    };
    const content = viewport.firstElementChild;
    const resizes =
      typeof ResizeObserver === "undefined" || !(content instanceof HTMLElement)
        ? null
        : new ResizeObserver(keepPlace);
    if (content instanceof HTMLElement) resizes?.observe(content);
    const finish = (): void => setPhase("done");
    for (const name of READER_EVENTS) viewport.addEventListener(name, finish, { passive: true });
    const timer = window.setTimeout(finish, SETTLE_MS);
    return () => {
      resizes?.disconnect();
      for (const name of READER_EVENTS) viewport.removeEventListener(name, finish);
      window.clearTimeout(timer);
    };
  }, [target, phase, viewportRef]);

  useEffect(() => {
    if (threadId === undefined || phase !== "done") return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    // What this page last left stored for the chat: undefined until the first save or clear.
    let stored: string | null | undefined;
    let frame: number | null = null;
    const save = (): void => {
      frame = null;
      if (isViewportAtBottom(viewport)) {
        if (stored !== null) {
          clearReadingPlace(threadId);
          stored = null;
        }
        return;
      }
      const anchor = captureVisibleMessageAnchor(viewport);
      const messageId = anchor === null ? undefined : rowStoreKey(anchor.row);
      if (anchor === null || messageId === undefined || messageId === "") return;
      // A provisional streaming id does not exist after a reload: such a place is not worth keeping.
      if (messageId.startsWith("stream:")) return;
      const place: ReadingPlace = { threadId, messageId, offset: anchor.offset };
      const serialized = JSON.stringify(place);
      if (serialized === stored) return;
      saveReadingPlace(place);
      stored = serialized;
    };
    // One save per frame: a scroll fires many events, and each save reads layout.
    const onScroll = (): void => {
      if (frame === null) frame = requestAnimationFrame(save);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [phase, threadId, viewportRef]);

  return { startsAtPlace: target !== null, resuming: phase !== "done" };
}
