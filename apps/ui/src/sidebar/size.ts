import { useCallback, useEffect, useState } from "react";

/** The narrowest and widest the chat list goes, in CSS pixels (#2805). */
export const LIST_MIN_PX = 180;
export const LIST_MAX_PX = 480;
/** How far an arrow key moves the list's edge. */
export const LIST_STEP_PX = 16;

const KEY = "omp-app:chat-list";

/**
 * The chat list as this device left it: its width (null for the layout's own, 244 px, 224 px on a smaller screen) and
 * whether it is hidden.
 */
export interface ChatListSize {
  readonly width: number | null;
  readonly hidden: boolean;
}

export const clampListWidth = (px: number): number =>
  Math.round(Math.min(LIST_MAX_PX, Math.max(LIST_MIN_PX, px)));

function kept(): ChatListSize {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      width:
        typeof value.width === "number" && Number.isFinite(value.width)
          ? clampListWidth(value.width)
          : null,
      hidden: value.hidden === true,
    };
  } catch {
    return { width: null, hidden: false };
  }
}

/**
 * The chat list's width and whether it is hidden (#2805), kept in this browser as the workspace tabs are: a reload brings
 * them back, and another device keeps its own.
 */
export function useChatListSize(): ChatListSize & {
  /** A new width, held between the limits; null goes back to the layout's own. */
  readonly resize: (px: number | null) => void;
  readonly toggle: () => void;
} {
  const [size, setSize] = useState(kept);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(size));
    } catch {
      // A browser that keeps nothing still resizes and hides the list for this page.
    }
  }, [size]);
  const resize = useCallback(
    (px: number | null) =>
      setSize((current) => ({ ...current, width: px === null ? null : clampListWidth(px) })),
    [],
  );
  const toggle = useCallback(
    () => setSize((current) => ({ ...current, hidden: !current.hidden })),
    [],
  );
  return { ...size, resize, toggle };
}
