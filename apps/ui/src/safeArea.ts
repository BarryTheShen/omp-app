import { useMemo, useSyncExternalStore } from "react";

/** The screen's safe-area insets in CSS pixels (`--safe-*`, `styles/index.css`): all 0 on a desktop. */
export interface SafeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const NONE: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
/** Base UI's own distance from the screen's edges, kept outside the safe area. */
const EDGE = 5;

let insets: SafeInsets = NONE;
let probe: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** CSS knows the insets (`env()`); script reads them off an invisible element padded by them. */
function measure(): void {
  if (probe === null) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)";
    document.body.append(probe);
  }
  const style = getComputedStyle(probe);
  const next = {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  };
  if (
    next.top === insets.top &&
    next.right === insets.right &&
    next.bottom === insets.bottom &&
    next.left === insets.left
  )
    return;
  insets = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("resize", measure);
  // Measured again whenever something floating opens: turning the phone, or a test, may have changed them.
  measure();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("resize", measure);
  };
}

export function useSafeInsets(): SafeInsets {
  return useSyncExternalStore(
    subscribe,
    () => insets,
    () => NONE,
  );
}

/**
 * How far a popover, menu, select or tooltip keeps from the screen's edges (Base UI's `collisionPadding`): its own 5 px
 * from the safe area, so that on a phone on its side it stays clear of the Dynamic Island and the curved corners.
 */
export function useCollisionPadding(): SafeInsets {
  const safe = useSafeInsets();
  return useMemo(
    () => ({
      top: safe.top + EDGE,
      right: safe.right + EDGE,
      bottom: safe.bottom + EDGE,
      left: safe.left + EDGE,
    }),
    [safe],
  );
}
