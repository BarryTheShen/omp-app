import { type Bridge, refusalText } from "./bridge";

/**
 * The desktop window's zoom (#2776), as a browser's: the webview draws the whole page larger or smaller, and Ctrl +,
 * Ctrl − and Ctrl 0 step through a browser's levels. A browser zooms its own pages, so this is the window's only.
 */
export const ZOOM_LEVELS: readonly number[] = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
];

const KEPT = "omp-app.ui.zoom";

/** The level kept from the last change, 1 when there is none, one these levels do not have, or storage is off. */
export function keptZoom(): number {
  let kept: number;
  try {
    kept = Number(localStorage.getItem(KEPT));
  } catch {
    return 1;
  }
  return ZOOM_LEVELS.includes(kept) ? kept : 1;
}

/** The level one step in `direction` from `current`; past either end it stays at the end. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const beyond =
    direction > 0
      ? ZOOM_LEVELS.find((level) => level > current)
      : ZOOM_LEVELS.findLast((level) => level < current);
  return beyond ?? current;
}

/**
 * Zooms the window to `level` and keeps it for the next start. A desktop app older than zoom refuses the call (its
 * permissions do not list it), which rejects with words a person acts on.
 */
export async function setDesktopZoom(bridge: Bridge, level: number): Promise<void> {
  try {
    await bridge.invoke("plugin:webview|set_webview_zoom", { value: level });
  } catch (failure) {
    const reason = refusalText(failure);
    if (/not allowed|not found/i.test(reason))
      throw new Error("This desktop app is older than zoom: install the newest desktop app.");
    throw new Error(`Zoom: ${reason}`);
  }
  try {
    localStorage.setItem(KEPT, String(level));
  } catch {
    // Storage can be off; the zoom then lasts until the window closes.
  }
}
