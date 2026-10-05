import type { PanelDescriptor } from "@omp-app/contracts";
import type { PanelLifecycle, PanelPosition } from "./contract";

/** Normative grammar copied by every later `kind: "panel"` module. */
export const PANEL_KIND_RULES = {
  kind: "panel" as const,
  modal: false as const,
  ownerOwnsDescriptor: true as const,
  u4OwnsModalDialogs: true as const,
  u0OwnsFocusAndTokens: true as const,
  passiveUpdatesStealFocus: false as const,
  secondTodoStore: false as const,
  requiresExplicitLifecycleStates: true as const,
  supportsPositions: ["left", "right", "inline"] as const satisfies readonly PanelPosition[],
  lifecycleStates: [
    "closed",
    "loading",
    "empty",
    "populated",
    "updating",
    "unavailable",
    "error",
  ] as const satisfies readonly PanelLifecycle[],
} as const;

/** Allowed lifecycle edges; an implementation must not jump from closed to updating/error data. */
export const PANEL_LIFECYCLE_TRANSITIONS: Readonly<
  Record<PanelLifecycle, readonly PanelLifecycle[]>
> = {
  closed: ["closed", "loading", "empty", "populated", "unavailable"],
  loading: ["loading", "empty", "populated", "updating", "unavailable", "error", "closed"],
  empty: ["empty", "loading", "populated", "updating", "unavailable", "error", "closed"],
  populated: ["populated", "updating", "empty", "unavailable", "error", "closed"],
  updating: ["updating", "populated", "empty", "unavailable", "error", "closed"],
  unavailable: ["unavailable", "loading", "empty", "populated", "error", "closed"],
  error: ["error", "loading", "empty", "populated", "unavailable", "closed"],
};

export function canTransitionPanelLifecycle(from: PanelLifecycle, to: PanelLifecycle): boolean {
  return PANEL_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export type PanelKindRules = typeof PANEL_KIND_RULES;

/** A narrow descriptor boundary that keeps descriptor composition in the main-agent registry. */
export interface U5PanelDescriptor extends PanelDescriptor {
  readonly kind: "panel";
}

export const PANEL_ESC_BEHAVIOR =
  "Esc closes this non-modal panel only after nested U4 modal layers have closed." as const;
export const PANEL_SCROLL_BEHAVIOR =
  "Manual scroll is preserved; passive updates expose a non-focus-stealing new-updates affordance." as const;
export const PANEL_STATE_OWNER =
  "A panel reads one immutable feature snapshot and routes mutations through its owning typed action." as const;
