import { useState } from "react";

/** The chat list's folded sections (Workspaces, Pinned, Chats…), by label, kept in this browser. */
const KEY = "omp-app.ui.list.folded";

function read(): ReadonlySet<string> {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(kept) ? kept.filter((label) => typeof label === "string") : []);
  } catch {
    return new Set();
  }
}

/** Which of the list's sections are folded, and what folds or unfolds one. */
export function useFolded(): readonly [ReadonlySet<string>, (label: string) => void] {
  const [folded, setFolded] = useState(read);
  const toggle = (label: string): void => {
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(label)) next.add(label);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        // No local storage: folded until the page goes.
      }
      return next;
    });
  };
  return [folded, toggle];
}
