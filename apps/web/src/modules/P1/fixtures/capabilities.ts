import { CapabilityMap, type CapabilityStatus } from "@omp-app/contracts";
import { P1CapabilityKeys } from "@/modules/P1/contract";

/**
 * Capability maps for gating. A key that is absent is unknown and counts as unavailable. The P1 client
 * enables a control only when the capability is `available` (client.ts, `requiredCapability`); the app's
 * shared gate also counts `fallback` (issue 1675), so the two can disagree on a fallback capability.
 */
const RPC_AVAILABLE: CapabilityStatus = { state: "available", via: "rpc" };
const HOST_AVAILABLE: CapabilityStatus = { state: "available", via: "host" };

/**
 * Builds a map from every P1 key, available unless `changes` says otherwise: `null` leaves the key out,
 * and a status replaces it. The result goes through the contract schema.
 */
function mapWith(changes: Readonly<Record<string, CapabilityStatus | null>>): CapabilityMap {
  const map: Record<string, CapabilityStatus> = {};
  for (const key of Object.values(P1CapabilityKeys)) {
    const change = changes[key];
    if (change === null) continue;
    map[key] = change ?? (key.startsWith("host.") ? HOST_AVAILABLE : RPC_AVAILABLE);
  }
  return CapabilityMap.parse(map);
}

/** The Agents settings dashboard is terminal-only: omp publishes no capability for it, so it stays unavailable. */
const DASHBOARD = ["P1.agentsCommand", "P1.agentsDashboard"];
const ADVISOR_COMMANDS = [
  "P1.advisor",
  "P1.advisorOn",
  "P1.advisorOff",
  "P1.advisorStatus",
  "P1.advisorDump",
  "P1.advisorMode",
];

export interface CapabilityCase {
  readonly name: string;
  readonly map: CapabilityMap;
  /** The descriptor ids that show as unavailable under this map. */
  readonly disabled: readonly string[];
}

export const P1_CAPABILITY_CASES: readonly CapabilityCase[] = [
  {
    name: "everything P1 needs is published",
    map: mapWith({}),
    disabled: DASHBOARD,
  },
  {
    name: "omp has no command gateway",
    map: mapWith({
      "host.command-gateway": {
        state: "unavailable",
        via: "host",
        detail: "The command gateway is not running.",
      },
    }),
    disabled: [...ADVISOR_COMMANDS, ...DASHBOARD],
  },
  {
    name: "omp publishes no subagent events",
    map: mapWith({ "omp.subagent-events": null }),
    disabled: ["P1.agentFeed", "P1.agentProgress", ...DASHBOARD],
  },
  {
    name: "transcripts are only a fallback (the client refuses it; the shared gate counts it, issue 1675)",
    map: mapWith({
      "omp.cmd.get_subagent_messages": {
        state: "fallback",
        via: "rpc",
        detail: "Transcripts are read from the saved session file.",
      },
    }),
    disabled: ["P1.focusedAgent", "P1.agentTranscriptViewer", "P1.agentTranscript", ...DASHBOARD],
  },
  {
    name: "the roster is unavailable",
    map: mapWith({ "omp.cmd.get_subagents": null }),
    disabled: ["P1.agentsHubDialog", "P1.agents", "P1.agentInspector", ...DASHBOARD],
  },
  {
    name: "cancel is not published",
    map: mapWith({ "omp.cmd.cancel_subagent": null }),
    disabled: ["P1.cancelSubagent", ...DASHBOARD],
  },
  {
    name: "steer is not published",
    map: mapWith({ "omp.cmd.steer_subagent": null }),
    disabled: ["P1.steerSubagent", ...DASHBOARD],
  },
  {
    name: "advisor settings are not writable",
    map: mapWith({
      "host.config": { state: "unavailable", via: "host", detail: "The settings store is closed." },
    }),
    disabled: [
      "P1.advisorConfigure",
      "P1.advisorConfigurationOverlay",
      "P1.advisorSettings",
      ...DASHBOARD,
    ],
  },
];
