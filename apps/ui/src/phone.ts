import { useSyncExternalStore } from "react";

/** Tailwind's `sm` breakpoint: below it, the phone's layout, with one pane. */
export const PHONE = "(max-width: 639px)";

/** Whether the page has the phone's layout now. */
export function isPhone(): boolean {
  return matchMedia(PHONE).matches;
}

/** Whether the page has the phone's layout, following the window's width. */
export function usePhone(): boolean {
  return useSyncExternalStore((notify) => {
    const query = matchMedia(PHONE);
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  }, isPhone);
}
