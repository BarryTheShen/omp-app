import type { SlashCommand } from "@omp-app/contracts";
import { SlashCommand as SlashCommandSchema } from "@omp-app/contracts";
import type { ExecutionMode } from "../contract";

/** The browser mode has two explicit, server-supported visibility choices. */
export type BrowserVisibility = "headless" | "visible";

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
 * Maps only the exact commands owned by D7 to their wire-facing slash spelling.
 * No command result text is inspected here; the gateway owns admission and settlement.
 */
export function modeCommand(action: ModeAction): SlashCommand | null {
  let command: string | null;
  switch (action.mode) {
    case "browser":
      command = `/browser ${action.visibility}`;
      break;
    case "computer":
      command = `/computer ${action.requested ? "on" : "off"}`;
      break;
    case "extended-context":
      command = `/extended-context ${action.requested ? "on" : "off"}`;
      break;
    case "slow":
      command = `/slow ${action.requested ? "on" : "off"}`;
      break;
    case "default":
      command = null;
      break;
  }
  return command === null ? null : SlashCommandSchema.parse(command);
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
