import { useSyncExternalStore } from "react";

/** Tailwind's `sm` breakpoint: below it, the phone's layout, with one pane. */
export const PHONE = "(max-width: 639px)";

/** Whether the page has the phone's layout now. */
export function isPhone(): boolean {
  return matchMedia(PHONE).matches;
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
