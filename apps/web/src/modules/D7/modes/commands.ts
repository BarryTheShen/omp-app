import type { BrowserVisibility, ModeChangeRequest } from "@omp-app/contracts";
import type { ExecutionMode } from "../contract";

/** The browser mode has two explicit, server-supported visibility choices. */
export type { BrowserVisibility } from "@omp-app/contracts";

/** Modes with a boolean command state in omp's released slash-command grammar. */
export type ToggleMode = "computer" | "extended-context" | "slow";

export type ModeAction =
  | { readonly mode: "browser"; readonly visibility: BrowserVisibility }
  | { readonly mode: ToggleMode; readonly requested: boolean }
  | { readonly mode: "default"; readonly requested: true };

/** User-facing labels for the execution modes owned by D7's controls part. */
export const MODE_LABELS: Readonly<Record<ExecutionMode, string>> = {
  default: "Standard execution",
  browser: "Browser use",
  computer: "Computer use",
  "extended-context": "Extended context",
  fast: "Fast mode",
  force: "Force execution",
  prewalk: "Prewalk",
  shake: "Refresh context",
  skillful: "Skill listing",
  slow: "Slow mode",
  vision: "Image understanding",
};

/**
 * The typed request an action asks omp for, or null for standard execution, which has no command. The server owns
 * the command's spelling and reads omp's reply; no command text is built or matched here.
 */
export function modeChangeRequest(action: ModeAction): ModeChangeRequest | null {
  if (action.mode === "default") return null;
  if (action.mode === "browser") return { mode: "browser", visibility: action.visibility };
  return { mode: action.mode, requested: action.requested };
}

/** The D7.3 scope deliberately excludes commands implemented by D7.4. */
export const D73_MODES = [
  "default",
  "browser",
  "computer",
  "extended-context",
  "fast",
  "slow",
] as const satisfies readonly ExecutionMode[];
export type D73Mode = (typeof D73_MODES)[number];

export function isD73Mode(mode: ExecutionMode): mode is D73Mode {
  return (D73_MODES as readonly ExecutionMode[]).includes(mode);
}
