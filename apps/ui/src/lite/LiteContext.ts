import { createContext } from "react";

/**
 * Whether the chat shows in the lite view (#2843), another app's side panel: there the transcript leaves out omp's
 * start-up status lines, and a warning or an error is one line (#2844). False in the full app.
 */
export const LiteContext = createContext(false);
