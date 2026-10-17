import { useEffect, useRef, useState } from "react";

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
  const [state, setState] = useState(() => ({
    source: items,
    armed,
    shown: mergePresence<T>(null, items, keyOf, false),
  }));
  let shown = state.shown;
  if (state.source !== items || state.armed !== armed) {
    // Items join only once the list was already loaded at the previous draw; the load itself enters nothing.
    shown = mergePresence(state.armed && armed ? state.shown : null, items, keyOf, false);
    setState({ source: items, armed, shown });
  }
  return shown;
}

/**
 * The list's items with the ones that left still drawn, marked `leaving`, for `leaveMs` (long enough for the fade).
 * A reader who prefers reduced motion gets no such time: a removed item is dropped at once. An item that comes back
 * while it leaves is drawn as present again.
 */
export function usePresentItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  leaveMs: number,
  armed = true,
): readonly Presence<T>[] {
  const [state, setState] = useState(() => ({
    source: items,
    armed,
    shown: mergePresence<T>(null, items, keyOf, true),
  }));
  let shown = state.shown;
  if (state.source !== items || state.armed !== armed) {
    shown = mergePresence(
      state.armed && armed ? state.shown : null,
      items,
      keyOf,
      !prefersReducedMotion(),
    );
    setState({ source: items, armed, shown });
  }

  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    for (const entry of shown) {
      const key = keyOf(entry.item);
      if (!entry.leaving) {
        const timer = pending.get(key);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          pending.delete(key);
        }
      } else if (!pending.has(key)) {
        pending.set(
          key,
          window.setTimeout(() => {
            pending.delete(key);
            setState((current) => ({
              ...current,
              shown: current.shown.filter((e) => !e.leaving || keyOf(e.item) !== key),
            }));
          }, leaveMs),
        );
      }
    }
  }, [shown, keyOf, leaveMs]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return shown;
}
