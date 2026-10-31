import { useSyncExternalStore } from "react";
import { PALETTES } from "./palettes";

/** A look: a block of `src/styles/themes.css`, named by its id. */
export interface ThemeInfo {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly mode: "dark" | "light";
}

/** Every look: Tern's two, then the palette themes (`palettes.ts`). */
export const THEMES: readonly ThemeInfo[] = [
  { id: "tern-dark", name: "Tern Dark", family: "Tern", mode: "dark" },
  { id: "tern-light", name: "Tern Light", family: "Tern", mode: "light" },
  ...PALETTES.map(({ id, name, family, mode }) => ({ id, name, family, mode })),
];

const byId = new Map(THEMES.map((theme) => [theme.id, theme]));

/** A theme's id, or "system": the light or the dark theme kept for the system's own mode. */
export type ThemeChoice = string;

/**
 * index.html's boot script reads the same keys, so the first paint already has the chosen theme: the choice, the mode of
 * a chosen theme (for Tailwind's `dark`), and the light and the dark theme "system" follows.
 */
const CHOICE_KEY = "omp-app.ui.theme";
const MODE_KEY = "omp-app.ui.theme.mode";
const SYSTEM_KEYS = { light: "omp-app.ui.theme.light", dark: "omp-app.ui.theme.dark" } as const;
const DEFAULT_CHOICE: ThemeChoice = "tern-dark";
const SYSTEM_DEFAULTS = { light: "tern-light", dark: "tern-dark" } as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be off; the choice then lasts until the page is closed.
  }
}

const isChoice = (value: string | null): value is ThemeChoice =>
  value === "system" || (value !== null && byId.has(value));

/** The theme "system" uses for a mode: the one kept for it, if it is a theme of that mode. */
function systemTheme(mode: "light" | "dark"): ThemeInfo {
  const kept = byId.get(read(SYSTEM_KEYS[mode]) ?? "");
  return kept?.mode === mode ? kept : (byId.get(SYSTEM_DEFAULTS[mode]) as ThemeInfo);
}

const systemLight = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: light)");

let choice: ThemeChoice = DEFAULT_CHOICE;
/** A theme shown for a moment (a gallery card, a palette row), not kept. */
let preview: string | null = null;
const listeners = new Set<() => void>();

function resolved(): ThemeInfo {
  if (preview !== null) {
    const shown = byId.get(preview);
    if (shown !== undefined) return shown;
  }
  if (choice === "system") return systemTheme(systemLight().matches ? "light" : "dark");
  return byId.get(choice) ?? (byId.get(DEFAULT_CHOICE) as ThemeInfo);
}

function apply(): void {
  const theme = resolved();
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle("dark", theme.mode === "dark");
}

function changed(): void {
  apply();
  for (const listener of listeners) listener();
}

/** Picks a theme, or "system". It applies at once, here and in the app's other windows, and is kept for the next visit. */
export function setThemeChoice(next: ThemeChoice): void {
  write(CHOICE_KEY, next);
  const theme = byId.get(next);
  if (theme !== undefined) write(MODE_KEY, theme.mode);
  choice = next;
  preview = null;
  changed();
}

/** Keeps `id` as the theme "system" uses for that theme's mode. */
export function setSystemTheme(id: string): void {
  const theme = byId.get(id);
  if (theme === undefined) return;
  write(SYSTEM_KEYS[theme.mode], id);
  changed();
}

/** Shows a theme until the preview ends (null): the kept choice is untouched. */
export function previewTheme(id: string | null): void {
  if (preview === id) return;
  preview = id;
  changed();
}

/**
 * Picks a theme from the gallery or the palette: it becomes the kept theme of its mode. It shows at once, unless the
 * choice follows the system and the system is in the other mode: then it shows when the system turns to its mode.
 */
export function pickTheme(id: string): void {
  const theme = byId.get(id);
  if (theme === undefined) return;
  write(SYSTEM_KEYS[theme.mode], id);
  if (choice === "system") {
    preview = null;
    changed();
  } else {
    setThemeChoice(id);
  }
}

/** What the one-click switch and a phone's menu offer: follow the system, or the kept light or dark theme. */
export type ThemeMode = "system" | "light" | "dark";

export function setThemeMode(mode: ThemeMode): void {
  setThemeChoice(mode === "system" ? "system" : systemTheme(mode).id);
}

/** Applies the kept choice, follows the system while the choice is "system", and follows changes made in other windows. */
export function startTheme(): void {
  const kept = read(CHOICE_KEY);
  choice = isChoice(kept) ? kept : DEFAULT_CHOICE;
  changed();
  systemLight().addEventListener("change", () => {
    if (choice === "system") changed();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === CHOICE_KEY) {
      const next = read(CHOICE_KEY);
      choice = isChoice(next) ? next : DEFAULT_CHOICE;
      changed();
    } else if (event.key === SYSTEM_KEYS.light || event.key === SYSTEM_KEYS.dark) {
      changed();
    }
  });
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice);
}

/** Where the one-click switch stands: following the system, or a light or a dark theme. */
export function useThemeMode(): ThemeMode {
  const kept = useThemeChoice();
  return kept === "system" ? "system" : (byId.get(kept)?.mode ?? "dark");
}

/** The themes "system" follows, light and dark. */
export function useSystemThemes(): { readonly light: ThemeInfo; readonly dark: ThemeInfo } {
  const light = useSyncExternalStore(subscribe, () => systemTheme("light"));
  const dark = useSyncExternalStore(subscribe, () => systemTheme("dark"));
  return { light, dark };
}

/** The theme on screen now: the kept one, or a preview. */
export function useShownTheme(): ThemeInfo {
  return useSyncExternalStore(subscribe, resolved);
}
