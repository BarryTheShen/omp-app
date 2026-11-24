import { useSyncExternalStore } from "react";

/**
 * Whether the setup is open, asked from Settings → App, the palette or the first-launch card, and the proposal block it
 * reviews when a chat's **Review these settings** opened it (`proposal.ts`); null for the questions.
 */
interface SetupOpen {
  readonly open: boolean;
  readonly proposal: string | null;
}

let state: SetupOpen = { open: false, proposal: null };
const listeners = new Set<() => void>();

function set(next: SetupOpen): void {
  state = next;
  for (const listener of listeners) listener();
}

export function setSetupOpen(open: boolean): void {
  if (state.open === open && state.proposal === null) return;
  set({ open, proposal: null });
}

/** Opens the setup on a chat's proposal: its plan of changes, to apply or not. */
export function reviewSetupProposal(text: string): void {
  set({ open: true, proposal: text });
}

export function useSetupOpen(): SetupOpen {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}
