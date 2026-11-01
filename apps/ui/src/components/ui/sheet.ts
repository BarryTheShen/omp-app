import type { MouseEvent } from "react";

/**
 * On a phone, menus, popovers and selects are bottom sheets over the page dimmed (`styles/index.css`, #2770). This is
 * the dimmed page's class: only on a phone, above Base UI's own backdrop and below the sheet, and a pointer so that iOS
 * takes it as clickable and sends a tap's click to it.
 */
export const SHEET_BACKDROP = "fixed inset-0 z-50 cursor-pointer bg-black/30 sm:hidden";

/**
 * A tap on the dimmed page closes the sheet, as Escape does. Base UI waits for a mouse event after a touch outside a
 * sheet, which iOS sends only to an element it takes as clickable, and Base UI's own backdrop is not one.
 */
export function closeSheet(event: MouseEvent<HTMLElement>): void {
  event.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}
