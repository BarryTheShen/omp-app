import { Descriptor } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import INVENTORY from "../../../../../../packages/contracts/src/core/inventory.json";
import {
  capabilityAvailable,
  D7_ALL_CAPABILITIES,
  D7_AP6_CAPABILITY,
  D7_AP6_UNAVAILABLE,
  D7_COMMAND_DESCRIPTORS,
  D7_DESCRIPTORS,
  D7_FIXTURE_MODE_SNAPSHOT,
  D7_PRECEDENCE_STATES,
  D7_RECONNECT_UNKNOWN_MODE_STATE,
  D7_REQUESTED_MODE_STATE,
  MODE_CAPABILITY_REQUIREMENTS,
  ModeSnapshot,
  ModeState,
  modeState,
  resolveModePrecedence,
  ToolAvailability,
  unavailableMode,
} from "../";

const INVENTORY_ROWS = INVENTORY as readonly {
  readonly id: string;
  readonly group: string;
  readonly name: string;
}[];
const D7_MODE_PREFIXES = [
  "browser",
  "computer",
  "extended-context",
  "fast",
  "slow",
  "force",
  "prewalk",
  "shake",
  "skillful",
  "default",
  "vision",
] as const;
const D7_COVERAGE = INVENTORY_ROWS.filter(
  (row) =>
    row.id === "C4.tools" ||
    (row.group === "C3" &&
      D7_MODE_PREFIXES.some(
        (prefix) =>
          row.name === prefix ||
          row.name.startsWith(`${prefix} `) ||
          row.name.startsWith(`${prefix}-`) ||
          row.name.replaceAll(" ", "-").startsWith(prefix),
      )),
).map((row) => row.id);

describe("D7.5 descriptor gate", () => {
  test("covers every D7 and C4.tools row exactly once", () => {
    const covers = D7_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect([...new Set(covers)]).toHaveLength(covers.length);
    expect(covers.toSorted()).toEqual([...D7_COVERAGE].toSorted());
  });

  test("registers schema-valid readable descriptors with unique slash claims and capability requirements", () => {
    for (const descriptor of D7_DESCRIPTORS) {
      expect(Descriptor.safeParse(descriptor).success).toBe(true);
      expect(descriptor.title).not.toMatch(
        /\b(?:C3|C4|RPC|AP\d|upstream|capability|module)\b|omp\.cmd/i,
      );
    }
    const expectedModeBySlash: Record<string, keyof typeof MODE_CAPABILITY_REQUIREMENTS> = {
      browser: "browser",
      computer: "computer",
      "extended-context": "extended-context",
      fast: "fast",
      slow: "slow",
      force: "force",
      prewalk: "prewalk",
      shake: "shake",
      skillful: "skillful",
    };
    for (const descriptor of D7_COMMAND_DESCRIPTORS) {
      const mode =
        descriptor.slash === undefined ? undefined : expectedModeBySlash[descriptor.slash.name];
      if (mode === undefined) {
        expect(descriptor.slash?.name).toBe("tools");
        expect(descriptor.requires).toEqual(["host.command-gateway"]);
      } else {
        expect(descriptor.requires).toEqual(MODE_CAPABILITY_REQUIREMENTS[mode]);
      }
    }
    const slashNames = D7_DESCRIPTORS.flatMap((descriptor) =>
      descriptor.kind === "command" && descriptor.slash ? [descriptor.slash.name] : [],
    );
    expect(new Set(slashNames).size).toBe(slashNames.length);
    expect(slashNames).toContain("tools");
  });
});

describe("D7.5 fixture and AP gate", () => {
  test("keeps all capability statuses explicit and validates the complete mode fixture", () => {
    expect(capabilityAvailable(D7_ALL_CAPABILITIES, "host.command-gateway")).toBe(true);
    expect(capabilityAvailable(D7_AP6_UNAVAILABLE, D7_AP6_CAPABILITY)).toBe(false);
    expect(ModeSnapshot.safeParse(D7_FIXTURE_MODE_SNAPSHOT).success).toBe(true);
    expect(D7_FIXTURE_MODE_SNAPSHOT.precedence[0]).toMatchObject({
      mode: "fast",
      scope: "session",
      state: "fallback",
      priority: 3,
    });
    expect(D7_FIXTURE_MODE_SNAPSHOT.precedence[1]).toMatchObject({
      mode: "default",
      scope: "default",
      priority: 1,
    });
    const flipped = resolveModePrecedence(
      D7_PRECEDENCE_STATES.map((state) => ({
        ...state,
        scope: state.mode === "fast" ? ("default" as const) : ("session" as const),
      })),
    );
    expect(flipped[0]).toMatchObject({ mode: "default", scope: "session", priority: 3 });
    expect(D7_FIXTURE_MODE_SNAPSHOT.fast).toMatchObject({
      enabled: true,
      active: false,
      state: "fallback",
    });
    expect(D7_FIXTURE_MODE_SNAPSHOT.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "browser", state: "available" }),
        expect.objectContaining({ tool: "computer", state: "fallback" }),
      ]),
    );
  });

  test("keeps requested and reconnect fallback states typed without parsing prose", () => {
    expect(ModeState.safeParse(D7_REQUESTED_MODE_STATE).success).toBe(true);
    expect(D7_REQUESTED_MODE_STATE.state).toBe("requested");
    expect(D7_RECONNECT_UNKNOWN_MODE_STATE).toMatchObject({
      state: "fallback",
      capability: D7_AP6_CAPABILITY,
      reason: "The app cannot read this setting from omp yet.",
    });
    expect(unavailableMode("prewalk", "session", "upstream")).toMatchObject({
      state: "unavailable",
      capability: D7_AP6_CAPABILITY,
      reason: "The app cannot read this setting from omp yet.",
    });
    const knownBrowser = modeState(
      "browser",
      "session",
      "omp-session",
      "known",
      D7_ALL_CAPABILITIES,
    );
    expect(knownBrowser.state).toBe("known");
    expect(knownBrowser.reason).toBeUndefined();
    expect(ToolAvailability.parse({ tool: "bash", state: "unknown" }).state).toBe("unknown");
  });
});
