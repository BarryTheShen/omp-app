import { createContext, useContext } from "react";
import { DEFAULT_LARGE_PASTE_LINE_THRESHOLD } from "../attachments";

/**
 * The line count at which a paste is offered the choice of where it goes; 0 turns the choice off. The app provides omp's
 * `paste.largeMenuThreshold` (Settings > Interaction > Large Paste Menu) for the open workspace. Outside a provider,
 * omp's default applies.
 */
export const LargePasteMenuThresholdContext = createContext<number>(
  DEFAULT_LARGE_PASTE_LINE_THRESHOLD,
);

/** The line count a composer offers the choice at, as the setting has it now. */
export function useLargePasteMenuThreshold(): number {
  return useContext(LargePasteMenuThresholdContext);
}
