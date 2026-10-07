import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  applyTheme,
  DARK_QUERY,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";

/**
 * The theme choice lives in one place, so the control in the sidebar, the page and a Settings screen
 * all read and write the same value. Reading goes to the browser's storage each time (a cheap string);
 * writing notifies every listener. Another tab's change arrives as a storage event.
 */
const listeners = new Set<() => void>();
/** Only when the browser refused to save the choice: it then lasts for this page view. */
let unsaved: ThemePreference | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function setThemePreference(next: ThemePreference): void {
  unsaved = saveThemePreference(next) ? undefined : next;
  notify();
}

function getThemePreference(): ThemePreference {
  return unsaved ?? readThemePreference();
}

function subscribeToPreference(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    // Another tab chose a theme (key null means the storage was cleared).
    if (event.key === THEME_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** What the person chose: System (the default), Light or Dark. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeToPreference, getThemePreference, () => "system");
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/**
 * Keeps the page's theme in step with the choice and, while the choice is System, with the
 * browser's own dark or light setting. Mounted once, at the top of the app, so the theme holds on
 * every screen and whether or not the control is on screen.
 */
export function ThemeApplier(): null {
  const preference = useThemePreference();
  const prefersDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark, () => false);
  const theme = resolveTheme(preference, prefersDark);
  useLayoutEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);
  return null;
}
