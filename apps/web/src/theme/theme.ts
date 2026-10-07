/**
 * The app's light and dark theme. The person's choice is Light, Dark or System; System follows the
 * browser's own dark or light setting live. The palette itself is `styles/tokens.css`: dark is the
 * `.dark` class on the page's root element.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Also read by the inline script in `index.html`, which sets the class before the first paint. */
export const THEME_STORAGE_KEY = "omp-app.theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/** Anything that is not an explicit Light or Dark is System: the default, and a safe fallback. */
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readThemePreference(storage: Storage | undefined = safeStorage()): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Saves the choice; false when the browser refused to keep it (it then lasts for this page view only). */
export function saveThemePreference(
  preference: ThemePreference,
  storage: Storage | undefined = safeStorage(),
): boolean {
  if (storage === undefined) return false;
  try {
    // System is the default: store nothing, so a later change of the default reaches everyone.
    if (preference === "system") storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

/** Puts the theme on the page: the `.dark` class the palette keys on, and the browser's own widgets. */
export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}
