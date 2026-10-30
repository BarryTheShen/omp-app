/**
 * What a view showed last, so it shows that at once when it opens again (in another pane, for a new chat, the panel
 * shown again) while it asks for the current one, which then replaces it. A view that passes `check` also keeps it in
 * this browser's storage, so a reload shows it at once too; what storage holds goes through `check` before it is used,
 * since an older version of the app may have written it.
 */
const STORAGE_PREFIX = "omp-app.ui.last.";
const memory = new Map<string, unknown>();

export interface LastSeen<T> {
  readonly get: () => T | undefined;
  readonly set: (value: T) => void;
}

export function lastSeen<T>(key: string, check?: (stored: unknown) => T | undefined): LastSeen<T> {
  const storageKey = STORAGE_PREFIX + key;
  return {
    get: () => {
      if (memory.has(key)) return memory.get(key) as T;
      if (check === undefined) return undefined;
      let value: T | undefined;
      try {
        const text = localStorage.getItem(storageKey);
        value = text === null ? undefined : check(JSON.parse(text));
      } catch {
        return undefined;
      }
      if (value !== undefined) memory.set(key, value);
      return value;
    },
    set: (value) => {
      memory.set(key, value);
      if (check === undefined) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(value));
      } catch {
        // Storage is full or blocked: this page still has it.
      }
    },
  };
}
