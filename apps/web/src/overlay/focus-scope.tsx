"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { FocusTarget } from "./grammar";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable=true]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getTabbableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    if (element.closest("[inert]")) return false;
    return element.tabIndex >= 0;
  });
}

function isConnectedElement(value: HTMLElement | null): value is HTMLElement {
  // `closest`, not `hasAttribute`: OverlayHost makes a whole background subtree inert, and calling
  // focus() on anything inside it silently does nothing.
  return value?.isConnected === true && !value.hidden && value.closest("[inert]") === null;
}

function resolveFocusTarget(target: FocusTarget | undefined): HTMLElement | null {
  if (typeof target === "function") return target();
  return target ?? null;
}

function focusElement(element: HTMLElement | null): void {
  if (!isConnectedElement(element)) return;
  element.focus({ preventScroll: true });
}

export interface FocusScopeProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  children?: ReactNode;
  /** Keep keyboard focus within this scope. Modal overlays set this to `true`. */
  trapped?: boolean;
  /** `false` preserves the current focus; otherwise the first tabbable element is chosen. */
  initialFocus?: FocusTarget | false;
  /** Lazy or explicit target for close; omitted means the opener captured on mount. */
  restoreFocus?: FocusTarget | false;
}

/**
 * Focus behavior shared by U0 overlays and U4 dialogs. It captures the opener before moving focus
 * in, loops Tab/Shift+Tab through the scope when trapped, handles programmatic focus leaving the
 * scope, and restores a connected opener/target when the scope really unmounts. A removed opener is
 * ignored safely.
 */
export function FocusScope({
  children,
  trapped = false,
  initialFocus,
  restoreFocus,
  className,
  ...props
}: FocusScopeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(false);
  const initialFocusPendingRef = useRef(true);
  // The latest props, read through refs so a parent that passes a fresh closure on every render
  // never re-runs the mount effect (which would re-capture the opener and re-steal focus).
  const initialFocusRef = useRef(initialFocus);
  const restoreFocusRef = useRef(restoreFocus);
  useLayoutEffect(() => {
    initialFocusRef.current = initialFocus;
    restoreFocusRef.current = restoreFocus;
  });

  const focusFirst = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const first = getTabbableElements(root)[0] ?? root;
    focusElement(first);
  }, []);

  useLayoutEffect(() => {
    mountedRef.current = true;
    if (openerRef.current === null) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
    }

    if (initialFocusPendingRef.current) {
      initialFocusPendingRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) return;
        const initial = initialFocusRef.current;
        if (initial === false) return;
        const root = rootRef.current;
        if (!root) return;
        const explicitTarget = resolveFocusTarget(initial);
        focusElement(explicitTarget);
        if (explicitTarget === null) focusFirst();
      });
    }

    return () => {
      mountedRef.current = false;
      // React's development double-invocation (StrictMode) unmounts and remounts this effect
      // synchronously, and OverlayHost clears the background's inert state in the same commit as
      // the real unmount. Deciding after the commit settles means only a scope that is still
      // unmounted has really closed, and its opener can take focus again.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        const restore = restoreFocusRef.current;
        if (restore === false) return;
        focusElement(resolveFocusTarget(restore) ?? openerRef.current);
      });
    };
  }, [focusFirst]);

  useLayoutEffect(() => {
    if (!trapped) return;
    const root = rootRef.current;
    if (!root) return;

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root.contains(target)) return;
      // A popup that something inside the dialog opened (a list, a popover) is rendered in a portal
      // outside the dialog's markup. Focus inside it belongs to the dialog; pulling it back would
      // close the popup the moment it opens. The page behind a modal is inert, so no other
      // portal can take focus.
      if (target instanceof Element && target.closest("[data-base-ui-portal]") !== null) return;
      focusFirst();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !root.contains(active)) return;
      const tabbable = getTabbableElements(root);
      if (tabbable.length === 0) {
        event.preventDefault();
        focusElement(root);
        return;
      }
      const first = tabbable[0] ?? null;
      const last = tabbable[tabbable.length - 1] ?? null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        focusElement(last);
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        focusElement(first);
      }
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [focusFirst, trapped]);

  return (
    <div
      {...props}
      ref={rootRef}
      className={className}
      data-focus-scope="true"
      tabIndex={props.tabIndex ?? -1}
    >
      {children}
    </div>
  );
}

export { getTabbableElements };
