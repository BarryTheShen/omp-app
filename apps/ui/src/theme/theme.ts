import { useSyncExternalStore } from "react";

/** The looks, each a block of `src/styles/themes.css`. */
export type Theme = "tern-dark" | "tern-light";
export type ThemeChoice = Theme | "system";

/** index.html's boot script uses the same key, default and rule, so the first paint already has the chosen theme. */
const STORAGE_KEY = "omp-app.ui.theme";
const DEFAULT_CHOICE: ThemeChoice = "tern-dark";

const isChoice = (value: string | null): value is ThemeChoice =>
  value === "system" || value === "tern-dark" || value === "tern-light";

function storedChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isChoice(value) ? value : DEFAULT_CHOICE;
  } catch {
    return DEFAULT_CHOICE;
  }
}

const systemLight = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: light)");

let choice: ThemeChoice = DEFAULT_CHOICE;
const listeners = new Set<() => void>();

function apply(): void {
  const theme: Theme =
    choice === "system" ? (systemLight().matches ? "tern-light" : "tern-dark") : choice;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "tern-dark");
}

function update(next: ThemeChoice): void {
  choice = next;
  apply();
  for (const listener of listeners) listener();
}

/** Picks a theme. It applies at once, here and in the app's other windows, and is kept for the next visit. */
export function setThemeChoice(next: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be off; the choice then lasts until the page is closed.
  }
  update(next);
}

/** Applies the kept choice, follows the system while the choice is "system", and follows changes made in other windows. */
export function startTheme(): void {
  update(storedChoice());
  systemLight().addEventListener("change", () => {
    if (choice === "system") apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) update(storedChoice());
  });
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice);
}
