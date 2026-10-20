export interface SettingsClosedSignal {
  readonly count: () => number;
  readonly subscribe: (listener: () => void) => () => void;
  readonly bump: () => void;
}

export function createSettingsClosedSignal(): SettingsClosedSignal {
  let count = 0;
  const listeners = new Set<() => void>();
  return {
    count: () => count,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bump: () => {
      count += 1;
      for (const listener of listeners) listener();
    },
  };
}
