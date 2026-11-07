import { useSyncExternalStore } from "react";

/** Tailwind's `sm` breakpoint: below it, the phone's layout, with one pane. */
export const PHONE = "(max-width: 639px)";

/**
 * Whether the page keeps a computer's layout at any width: the lite view on a computer (#2845), in another app's side
 * panel, which is always narrower than the phone's breakpoint. The page's boot script sets it (`data-desk` on the root)
 * where the main pointer is not a touch screen; the CSS's `max-sm`, `sm` and phone blocks read the same attribute.
 */
const desk = (): boolean => document.documentElement.hasAttribute("data-desk");

/** Whether the page has the phone's layout now. */
export function isPhone(): boolean {
  return !desk() && matchMedia(PHONE).matches;
}

/** A tablet: a touch screen as the main pointer, wider than a phone; the CSS `tablet:` variant is the same query. */
export const TABLET = "(pointer: coarse) and (min-width: 640px)";

/** Whether the page is on a tablet now. */
export function isTablet(): boolean {
  return matchMedia(TABLET).matches;
}

/** Whether the page has the phone's layout, following the window's width. */
export function usePhone(): boolean {
  return useSyncExternalStore((notify) => {
    const query = matchMedia(PHONE);
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  }, isPhone);
}
