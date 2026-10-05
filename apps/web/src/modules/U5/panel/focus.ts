import { useCallback, useLayoutEffect, useRef } from "react";
import type { PanelFocusToken } from "./contract";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface PanelFocusOptions {
  readonly open: boolean;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly onEscape: () => void;
}

export interface PanelFocusRefs {
  readonly panelRef: (node: HTMLElement | null) => void;
  readonly headingRef: (node: HTMLElement | null) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
}

/** Focuses only user-invoked opens, restores once on close, and lets passive updates preserve focus. */
export function usePanelFocus(options: PanelFocusOptions): PanelFocusRefs {
  const panelNode = useRef<HTMLElement | null>(null);
  const headingNode = useRef<HTMLElement | null>(null);
  const openerNode = useRef<HTMLElement | null>(null);
  const previousOpen = useRef(options.open);
  const restored = useRef(false);

  const panelRef = useCallback((node: HTMLElement | null) => {
    panelNode.current = node;
  }, []);
  const headingRef = useCallback((node: HTMLElement | null) => {
    headingNode.current = node;
  }, []);

  useLayoutEffect(() => {
    const wasOpen = previousOpen.current;
    if (!wasOpen && options.open) {
      restored.current = false;
      const active = document.activeElement;
      openerNode.current = active instanceof HTMLElement ? active : null;
      if (options.invokingFocus) {
        const target = firstFocusable(panelNode.current) ?? headingNode.current;
        target?.focus({ preventScroll: true });
      }
    }
    if (wasOpen && !options.open && !restored.current) {
      restored.current = true;
      if (options.invokingFocus) {
        options.restoreFocus?.(options.invokingFocus);
        if (!options.restoreFocus) openerNode.current?.focus({ preventScroll: true });
      }
    }
    previousOpen.current = options.open;
  }, [options.invokingFocus, options.open, options.restoreFocus]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
    },
    [options.onEscape],
  );

  return { panelRef, headingRef, onKeyDown };
}
