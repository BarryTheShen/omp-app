import { useAuiState } from "@assistant-ui/react";
import { createContext, type ReactNode } from "react";

/** The stop of the chat's running turn: the one the composer's stop button uses. */
export type TurnCancel = () => Promise<void>;

/**
 * The stop of the chat's running turn, for a tool card's own Stop turn button. A card in the chat's own transcript
 * reads it, so its button stops the turn. A card outside a chat, and a card in a read-only transcript (a worker's
 * or a nested task's), reads undefined and offers no Stop turn.
 */
export const TurnCancelContext = createContext<TurnCancel | undefined>(undefined);

/**
 * Gives the chat's turn stop only while the turn runs, on the same condition the composer's Stop generating uses. A
 * worker's card is not the chat's turn: once the turn has settled, the stop has nothing of this turn to stop, so it
 * is withheld. Renders inside the chat's assistant-ui runtime.
 */
export function TurnCancelScope({
  cancel,
  children,
}: {
  readonly cancel: TurnCancel;
  readonly children: ReactNode;
}) {
  const canCancel = useAuiState(
    (state) => state.thread.isRunning && state.thread.capabilities.cancel,
  );
  return (
    <TurnCancelContext.Provider value={canCancel ? cancel : undefined}>
      {children}
    </TurnCancelContext.Provider>
  );
}
