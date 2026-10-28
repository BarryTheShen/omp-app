import type { CapabilityMap } from "@omp-app/contracts";
import {
  D7_AP6_CAPABILITY,
  D7_AP6_REASON,
  D7_CAPABILITIES,
  FastModeState,
  ModeSnapshot,
  type ModeSnapshot as ModeSnapshotValue,
  ModeState,
  type ModeState as ModeStateValue,
  resolveModePrecedence,
  ToolAvailability,
} from "../contract";

// These are scrubbed stand-ins for A0/A1/R0 snapshots; they are not captured omp output.
export const D7_ALL_CAPABILITIES: CapabilityMap = Object.fromEntries(
  D7_CAPABILITIES.filter((key) => key !== D7_AP6_CAPABILITY).map((key) => [
    key,
    { state: "available", via: "omp" },
  ]),
);

export const D7_AP6_UNAVAILABLE: CapabilityMap = {
  [D7_AP6_CAPABILITY]: { state: "unavailable", via: "upstream", detail: D7_AP6_REASON },
};

const known = (mode: ModeStateValue["mode"], active = true): ModeStateValue =>
  ModeState.parse({
    mode,
    state: "known",
    scope: "session",
    source: "omp-session",
    active,
    enabled: active,
  });

export const D7_PRECEDENCE_STATES: readonly ModeStateValue[] = [
  ModeState.parse({
    mode: "fast",
    state: "fallback",
    scope: "session",
    source: "omp-session",
    enabled: true,
    active: false,
  }),
  ModeState.parse({
    mode: "default",
    state: "known",
    scope: "default",
    source: "config",
    active: true,
  }),
];

export const D7_FIXTURE_MODE_SNAPSHOT: ModeSnapshotValue = ModeSnapshot.parse({
  modes: {
    browser: known("browser"),
    computer: known("computer", false),
    "extended-context": known("extended-context"),
    fast: known("fast"),
    force: known("force", false),
    prewalk: known("prewalk", false),
    shake: known("shake", false),
    skillful: known("skillful"),
    slow: known("slow", false),
    default: known("default"),
  },
  // Stand-in fast provider result: v18.8.9 reports enabled and active separately, but this reason is synthetic.
  fast: FastModeState.parse({
    enabled: true,
    active: false,
    state: "fallback",
    scope: "session",
    source: "omp-session",
    reason: "The provider kept the standard tier.",
  }),
  precedence: resolveModePrecedence(D7_PRECEDENCE_STATES),
  // Stand-in tool list used to exercise availability states; it is not an omp catalog capture.
  tools: [
    ToolAvailability.parse({
      tool: "browser",
      mode: "browser",
      state: "available",
      capability: "host.command-gateway",
    }),
    ToolAvailability.parse({
      tool: "computer",
      mode: "computer",
      state: "fallback",
      capability: "host.command-gateway",
      reason: "Computer control is limited in this app.",
    }),
  ],
  revision: 4,
});

export const D7_REQUESTED_MODE_STATE = ModeState.parse({
  mode: "prewalk",
  state: "requested",
  scope: "command",
  source: "omp-command",
  requested: true,
});

export const D7_RECONNECT_UNKNOWN_MODE_STATE = ModeState.parse({
  mode: "extended-context",
  state: "fallback",
  scope: "session",
  source: "upstream",
  capability: D7_AP6_CAPABILITY,
  reason: D7_AP6_REASON,
});
