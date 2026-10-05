import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface PanelScrollState {
  readonly atBottom: boolean;
  readonly pendingUpdates: number;
}

export interface PanelScrollRefs {
  readonly bodyRef: (node: HTMLDivElement | null) => void;
  readonly onScroll: () => void;
  readonly jumpToLatest: () => void;
}

export interface UsePanelScrollResult {
  readonly state: PanelScrollState;
  readonly refs: PanelScrollRefs;
}

function isAtBottom(node: HTMLDivElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
}

/** Preserves a reader's manual position and exposes a non-focus-stealing latest-update affordance. */
export function usePanelScroll(contentVersion: unknown): UsePanelScrollResult {
  const bodyNode = useRef<HTMLDivElement | null>(null);
  const wasAtBottom = useRef(true);
  const [state, setState] = useState<PanelScrollState>({ atBottom: true, pendingUpdates: 0 });

  const bodyRef = useCallback((node: HTMLDivElement | null) => {
    bodyNode.current = node;
    if (node) wasAtBottom.current = isAtBottom(node);
  }, []);

  const onScroll = useCallback(() => {
    const node = bodyNode.current;
    if (!node) return;
    const atBottom = isAtBottom(node);
    wasAtBottom.current = atBottom;
    setState((previous) => ({
      atBottom,
      pendingUpdates: atBottom ? 0 : previous.pendingUpdates,
    }));
  }, []);

  const jumpToLatest = useCallback(() => {
    const node = bodyNode.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    wasAtBottom.current = true;
    setState({ atBottom: true, pendingUpdates: 0 });
  }, []);

  useLayoutEffect(() => {
    void contentVersion;
    const node = bodyNode.current;
    if (!node) return;
    if (wasAtBottom.current) {
      node.scrollTop = node.scrollHeight;
      setState({ atBottom: true, pendingUpdates: 0 });
      return;
    }
    setState((previous) => ({ atBottom: false, pendingUpdates: previous.pendingUpdates + 1 }));
  }, [contentVersion]);

  return { state, refs: { bodyRef, onScroll, jumpToLatest } };
}
