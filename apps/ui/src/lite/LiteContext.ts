import { createContext } from "react";
import type { LiteChoices } from "./lite";

/**
 * The lite view's choices when the chat shows there (#2843), in another app's side panel; null in the full app. There
 * the transcript leaves out omp's start-up status lines and a warning or an error is one line (#2844), and the empty
 * chat and the message box take the framing app's greeting, suggestions and placeholder (#2845).
 */
export const LiteContext = createContext<LiteChoices | null>(null);
