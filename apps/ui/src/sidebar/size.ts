import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** The narrowest and widest the chat list goes, in CSS pixels (#2805). */
export const LIST_MIN_PX = 180;
export const LIST_MAX_PX = 480;
/** How far an arrow key moves the list's edge. */
export const LIST_STEP_PX = 16;
/** The side panel's width as it opens beside the chat (the workspace's side pane). */
export const SIDE_PANE_PX = 320;
/** The least room a chat keeps beside an open side panel (#8): with less, the chat list steps aside for the panel. */
const CHAT_MIN_PX = 360;
/** The side panel's rail at the window's right edge: 40 px, 44 on a tablet. */
const RAIL_PX = 44;
/** The layout's own list width in a window of 1360 px or less; a wider window is far past where the list steps aside. */
const LIST_OWN_PX = 224;

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

/**
 * Whether this window is too narrow for the chat list, a side panel as it opens, its rail and a chat of 360 px (#8):
 * below 948 px with the layout's own list. Followed as the window resizes; it says nothing about the panel or the list.
 */
export function useNarrowForPanel(listWidth: number | null): boolean {
  const below = (listWidth ?? LIST_OWN_PX) + RAIL_PX + SIDE_PANE_PX + CHAT_MIN_PX;
  const query = `(max-width: ${below - 1}px)`;
  const subscribe = useCallback(
    (notify: () => void) => {
      const media = matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}
