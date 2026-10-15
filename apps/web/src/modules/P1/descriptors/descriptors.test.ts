import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { P1_DESCRIPTORS } from ".";

/**
 * The inventory rows P1 owns. The spec counts 20 P1 ids and eight advisor C3 ids, but the inventory
 * has nine advisor rows: the `/advisor` command plus its eight subcommand, mode, dialog and card rows.
 * The P1 header's own scope names the command, and research/modules/P1.md ("Advisor subset") assigns
 * all nine to P1, so P1 covers nine.
 */
const ownedRows: readonly string[] = [
  "P1.agents",
  "P1.cancel-subagent",
  "P1.steer-subagent",
  "P1.focused-subagent-session",
  "P1.agents-hub",
  "P1.agents-dashboard",
  "P1.hub",
  "P1.agent-transcript-viewer",
  "P1.double-left-agent-hub-gesture",
  "P1.app-agents-hub",
  "P1.irc-incoming-autoreply-relay-card",
  "P1.background-job-completed-row",
  "P1.background-tangent-dispatch-breadcrumb",
  "P1.live-delegation-message",
  "P1.supervised-process-completion-row",
  "P1.agent-hub-roster",
  "P1.agent-hub-selected-agent-inspector",
  "P1.rpc-subagent-lifecycle-progress-event-feed",
  "P1.fullscreen-subagent-advisor-transcript-viewer",
  "P1.subagent-progress-rows",
  "C3.advisor",
  "C3.advisor-configure",
  "C3.advisor-dump",
  "C3.advisor-off",
  "C3.advisor-on",
  "C3.advisor-status",
  "C3.advisor-mode",
  "C3.advisor-configuration-overlay",
  "C3.advisor-note-card",
  "S2.model-advisor",
];

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("P1 descriptor coverage", () => {
  test("claims exactly the 30 inventory rows P1 owns, each exactly once", () => {
    const liveRows = INVENTORY.filter((item) => ownedRows.includes(item.id)).map((item) => item.id);
    const descriptorRows = P1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect(sorted(liveRows)).toEqual(sorted(ownedRows));
    expect(sorted(descriptorRows)).toEqual(sorted(ownedRows));
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
  });

  test("derives the owned set from the inventory: 20 P1 rows less T5's task card, and nine advisor rows", () => {
    const p1Rows = INVENTORY.filter(
      (item) => item.group === "P1" && item.id !== "P1.task-subagent-card",
    ).map((item) => item.id);
    const advisorRows = INVENTORY.filter((item) => item.id.startsWith("C3.advisor")).map(
      (item) => item.id,
    );

    expect(p1Rows).toHaveLength(20);
    expect(advisorRows).toHaveLength(9);
    expect(sorted(p1Rows)).toEqual(sorted(ownedRows.filter((id) => id.startsWith("P1."))));
    expect(sorted(advisorRows)).toEqual(sorted(ownedRows.filter((id) => id.startsWith("C3."))));
  });

  test("gives every descriptor a P1. id owned by P1", () => {
    expect(P1_DESCRIPTORS.every((descriptor) => descriptor.owner === "P1")).toBe(true);
    expect(P1_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("P1."))).toBe(true);
  });

  test("passes C0 registry validation with no problems", () => {
    expect(validateRegistry(P1_DESCRIPTORS)).toEqual([]);
  });
});
