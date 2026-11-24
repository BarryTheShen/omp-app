/**
 * A look setting was changed here (light or dark, a theme, the style, tool groups, idle workspaces): `look/sync.ts`
 * hears it and, on Every device, saves the look on the server (V258). Kept apart so the settings' modules and the sync
 * do not import each other.
 */
const listeners = new Set<() => void>();

export function lookChanged(): void {
  for (const listener of listeners) listener();
}

export function onLookChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
