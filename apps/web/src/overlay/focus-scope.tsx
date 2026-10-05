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
  return value?.isConnected === true && !value.hidden && !value.hasAttribute("inert");
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
 * scope, and restores a connected opener/target exactly once. A removed opener is ignored safely.
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
  const restoredRef = useRef(false);
  const mountedRef = useRef(false);

  const focusFirst = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const first = getTabbableElements(root)[0] ?? root;
    focusElement(first);
  }, []);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;

    queueMicrotask(() => {
      if (!mountedRef.current) return;
      if (initialFocus === false) return;
      const root = rootRef.current;
      if (!root) return;
      const explicitTarget = resolveFocusTarget(initialFocus);
      focusElement(explicitTarget);
      if (explicitTarget === null) focusFirst();
    });

    return () => {
      mountedRef.current = false;
      if (restoredRef.current || restoreFocus === false) return;
      restoredRef.current = true;
      queueMicrotask(() => {
        const target = resolveFocusTarget(restoreFocus) ?? openerRef.current;
        focusElement(target);
      });
    };
  }, [focusFirst, initialFocus, restoreFocus]);

  useLayoutEffect(() => {
    if (!trapped) return;
    const root = rootRef.current;
    if (!root) return;

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root.contains(target)) return;
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
