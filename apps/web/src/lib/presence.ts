import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ENTER_MS } from "./motion";

/** An item of a list that may still be drawn after it left, so it can fade out before it is removed. */
export interface Presence<T> {
  readonly item: T;
  /** The item left the list and is fading out: it stays drawn, but inert, until it is removed. */
  readonly leaving: boolean;
  /** The item joined the list after the list first drew, so it fades in. The first draw's items never do. */
  readonly entering: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Calls `done` `ms` after the browser has drawn the frame that follows the caller, and returns a function that cancels it.
 * A fade starts in the first frame that draws its starting state (`@starting-style`, or the class a transition runs from).
 * A timer started at the commit can expire before any frame is drawn while the page is busy, and then the fade never starts
 * and the row goes at once; so the wait begins only after two frames have been drawn.
 */
function afterFrames(ms: number, done: () => void): () => void {
  let timer: number | undefined;
  let frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(done, ms);
    });
  });
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

/**
 * The next list in its own order. An item that left stays where it was, marked `leaving`, when `keepLeaving` is true;
 * otherwise it is dropped at once. `prev` is null for the first draw, whose items do not enter.
 */
export function mergePresence<T>(
  prev: readonly Presence<T>[] | null,
  next: readonly T[],
  keyOf: (item: T) => string,
  keepLeaving: boolean,
): Presence<T>[] {
  const previousKeys = new Set((prev ?? []).map((entry) => keyOf(entry.item)));
  const nextAt = new Map<string, number>();
  next.forEach((item, index) => {
    nextAt.set(keyOf(item), index);
  });
  const result: Presence<T>[] = [];
  const placed = new Set<string>();
  const place = (item: T, leaving: boolean): void => {
    const key = keyOf(item);
    if (placed.has(key)) return;
    placed.add(key);
    result.push({ item, leaving, entering: prev !== null && !leaving && !previousKeys.has(key) });
  };
  let cursor = 0;
  for (const entry of prev ?? []) {
    const at = nextAt.get(keyOf(entry.item));
    if (at === undefined) {
      if (keepLeaving) place(entry.item, true);
      continue;
    }
    // Every row of `next` up to and including this one comes next, in order; a row already placed is skipped.
    for (const item of next.slice(cursor, at + 1)) place(item, false);
    cursor = Math.max(cursor, at + 1);
  }
  for (const item of next.slice(cursor)) place(item, false);
  return result;
}

/**
 * The keys still holding `entering` after a merge: those held before that are still drawn, and those that joined in it. A
 * list may change again before a new row's fade has been drawn; the row must keep its fade class until then.
 */
function heldAfter<T>(
  previous: readonly string[],
  shown: readonly Presence<T>[],
  keyOf: (item: T) => string,
): string[] {
  const drawn = new Set(shown.map((entry) => keyOf(entry.item)));
  const joined = shown.filter((entry) => entry.entering).map((entry) => keyOf(entry.item));
  return [...new Set([...previous, ...joined])].filter((key) => drawn.has(key));
}

/**
 * The list with `entering` set exactly on the rows still held. A row is entering until its fade has been drawn and its time
 * has run, whatever the merge that drew it last said.
 */
function withHolds<T>(
  shown: readonly Presence<T>[],
  held: readonly string[],
  keyOf: (item: T) => string,
): readonly Presence<T>[] {
  return shown.map((entry) => {
    const entering = !entry.leaving && held.includes(keyOf(entry.item));
    return entering === entry.entering ? entry : { ...entry, entering };
  });
}

/**
 * Releases each held row, through `release`, `ENTER_MS` after its fade has been drawn. A row that is no longer held (it
 * left the list) has its timer cancelled.
 */
function useHoldTimers(held: readonly string[], release: (key: string) => void): void {
  const timers = useRef(new Map<string, () => void>());
  useEffect(() => {
    const pending = timers.current;
    for (const key of held) {
      if (pending.has(key)) continue;
      pending.set(
        key,
        afterFrames(ENTER_MS, () => {
          pending.delete(key);
          release(key);
        }),
      );
    }
    for (const [key, cancel] of pending) {
      if (held.includes(key)) continue;
      cancel();
      pending.delete(key);
    }
  }, [held, release]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const cancel of pending.values()) cancel();
      pending.clear();
    };
  }, []);
}

/**
 * The list's items, each marked `entering` when it joined after the list had loaded. `armed` is false until the list has
 * loaded: the rows it loads with (a page's first rows, a reload's rows) never enter. A removed item is dropped at once:
 * use this where the item's replacement is drawn in its place, so the same chat never shows twice. A running chat has
 * no creation time to judge by, so this is how it fades in once when it appears live.
 */
export function useEnteringItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  armed: boolean,
): readonly Presence<T>[] {
  const [state, setState] = useState(() => {
    const shown = mergePresence<T>(null, items, keyOf, false);
    return { source: items, armed, shown, held: heldAfter<T>([], shown, keyOf) };
  });
  let current = state;
  if (state.source !== items || state.armed !== armed) {
    // Items join only once the list was already loaded at the previous draw; the load itself enters nothing.
    const shown = mergePresence(state.armed && armed ? state.shown : null, items, keyOf, false);
    current = { source: items, armed, shown, held: heldAfter(state.held, shown, keyOf) };
    setState(current);
  }
  const release = useCallback((key: string) => {
    setState((latest) => ({ ...latest, held: latest.held.filter((heldKey) => heldKey !== key) }));
  }, []);
  useHoldTimers(current.held, release);
  const { shown, held } = current;
  return useMemo(() => withHolds(shown, held, keyOf), [shown, held, keyOf]);
}

/**
 * The list's items with the ones that left still drawn, marked `leaving`, for `leaveMs` after their fade has been drawn. A
 * reader who prefers reduced motion gets no such time: a removed item is dropped at once. An item that comes back while it
 * leaves is drawn as present again. A new item enters as `useEnteringItems` does.
 */
export function usePresentItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  leaveMs: number,
  armed = true,
): readonly Presence<T>[] {
  const [state, setState] = useState(() => {
    const shown = mergePresence<T>(null, items, keyOf, true);
    return { source: items, armed, shown, held: heldAfter<T>([], shown, keyOf) };
  });
  let current = state;
  if (state.source !== items || state.armed !== armed) {
    const shown = mergePresence(
      state.armed && armed ? state.shown : null,
      items,
      keyOf,
      !prefersReducedMotion(),
    );
    current = { source: items, armed, shown, held: heldAfter(state.held, shown, keyOf) };
    setState(current);
  }
  const { shown, held } = current;

  const release = useCallback((key: string) => {
    setState((latest) => ({ ...latest, held: latest.held.filter((heldKey) => heldKey !== key) }));
  }, []);
  useHoldTimers(held, release);

  const timers = useRef(new Map<string, () => void>());
  useEffect(() => {
    const pending = timers.current;
    for (const entry of shown) {
      const key = keyOf(entry.item);
      if (!entry.leaving) {
        pending.get(key)?.();
        pending.delete(key);
      } else if (!pending.has(key)) {
        pending.set(
          key,
          afterFrames(leaveMs, () => {
            pending.delete(key);
            setState((latest) => ({
              ...latest,
              shown: latest.shown.filter((e) => !e.leaving || keyOf(e.item) !== key),
            }));
          }),
        );
      }
    }
  }, [shown, keyOf, leaveMs]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const cancel of pending.values()) cancel();
      pending.clear();
    };
  }, []);

  return useMemo(() => withHolds(shown, held, keyOf), [shown, held, keyOf]);
}
