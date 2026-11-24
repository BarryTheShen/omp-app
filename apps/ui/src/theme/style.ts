import { useSyncExternalStore } from "react";
import { lookChanged } from "../look/changes";

/**
 * The app's style: how it is drawn apart from its colours (`styles/looks.css`). Kept in this browser like the theme;
 * applied before the first paint by `index.html` under the same key.
 */
export interface AppStyle {
  readonly id: string;
  readonly name: string;
  /** What it is like, in a line. */
  readonly words: string;
}

export const STYLES: readonly AppStyle[] = [
  { id: "tern", name: "Tern", words: "The app's own look: Geist, compact, cards." },
  {
    id: "paper",
    name: "Paper",
    words: "Answers in a serif reading column; quiet sans around them.",
  },
  { id: "console", name: "Console", words: "Dense and neutral, hairlines instead of cards." },
  { id: "blocks", name: "Blocks", words: "Every tool call a typed block with a mono header." },
  {
    id: "glass",
    name: "Glass",
    words: "Large radii, floating translucent panes on the theme's own page.",
  },
  { id: "roomy", name: "Roomy", words: "iPhone text sizes and finger-size rows everywhere." },
];

const KEY = "omp-app.ui.style";
const listeners = new Set<() => void>();

function read(): string {
  try {
    const kept = localStorage.getItem(KEY);
    return STYLES.some((style) => style.id === kept) ? (kept as string) : "tern";
  } catch {
    return "tern";
  }
}

function apply(id: string): void {
  if (id === "tern") delete document.documentElement.dataset.style;
  else document.documentElement.dataset.style = id;
}

/** Sets the style; `fromLook`: the look for every device brought it (`look/sync.ts`), not a change made here. */
export function setStyle(id: string, fromLook = false): void {
  if (!STYLES.some((style) => style.id === id)) return;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // No storage: the style holds until the page reloads.
  }
  apply(id);
  for (const listener of listeners) listener();
  if (!fromLook) lookChanged();
}

/** The style as this browser keeps it. */
export const styleNow = (): string => read();

/** The style in force, kept current. */
export function useStyle(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => "tern",
  );
}
