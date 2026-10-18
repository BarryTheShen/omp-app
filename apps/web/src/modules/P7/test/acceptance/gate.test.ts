import { CommandRunResult, type Descriptor, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { parseCompactArgs, parseUsageArgs } from "../../commands/grammar";
import { CompactionState, ContextUsageState, UsageSnapshot } from "../../contract";
import { P7_DESCRIPTORS } from "../../descriptors";
import {
  assertP7FixturesAreScrubbed,
  P7_COMMAND_RESULTS,
  P7_COMPACTION_FIXTURES,
  P7_CONTEXT_FIXTURES,
  P7_INVENTORY_ROWS,
  P7_USAGE_FIXTURES,
} from "../../fixtures";

describe("P7.6 W5, CC4 and CC12 acceptance gate", () => {
  test("covers the inventory once and passes C0 descriptor validation", () => {
    const covered = P7_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(P7_INVENTORY_ROWS).toHaveLength(28);
    expect(covered).toHaveLength(28);
    expect(new Set(covered).size).toBe(covered.length);
    expect(new Set(P7_INVENTORY_ROWS)).toEqual(new Set(covered));
    expect(validateRegistry(P7_DESCRIPTORS)).toEqual([]);
  });

  test("parses context, usage and compaction snapshots through their real contracts", () => {
    for (const fixture of P7_CONTEXT_FIXTURES)
      expect(ContextUsageState.parse(fixture)).toEqual(fixture);
    for (const fixture of P7_USAGE_FIXTURES) expect(UsageSnapshot.parse(fixture)).toEqual(fixture);
    for (const fixture of P7_COMPACTION_FIXTURES)
      expect(CompactionState.parse(fixture)).toEqual(fixture);
  });

  test("parses command results and keeps output separate from settlement", () => {
    for (const result of P7_COMMAND_RESULTS) {
      expect(CommandRunResult.parse(result)).toEqual(result);
    }
    expect(parseUsageArgs("reset provider/active")).toEqual({
      state: "valid",
      value: { kind: "reset", target: "provider/active" },
    });
    expect(parseCompactArgs("remote keep the newest decisions")).toEqual({
      state: "valid",
      value: { mode: "remote", focus: "keep the newest decisions" },
    });
  });
  test("pins every descriptor capability to its typed contract boundary", () => {
    const byId = new Map<string, Descriptor>(
      P7_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
    );
    for (const id of ["P7.context", "P7.stats", "P7.usage", "P7.compact"]) {
      expect(byId.get(id)?.requires).toEqual(["host.command-gateway"]);
    }
    for (const id of [
      "P7.status-context-percent",
      "P7.status-context-size",
      "P7.status-token-rate",
    ]) {
      expect(byId.get(id)?.requires).toEqual(["omp.cmd.get_state"]);
    }
    for (const id of [
      "P7.status-input-tokens",
      "P7.status-output-tokens",
      "P7.status-total-tokens",
      "P7.status-cache-hit",
      "P7.status-cache-read",
      "P7.status-cache-write",
      "P7.status-cost",
    ]) {
      expect(byId.get(id)?.requires).toEqual(["omp.cmd.get_session_stats"]);
    }
    expect(byId.get("P7.status-last-turn")?.requires).toEqual([]);
    expect(byId.get("P7.status-provider-limits")?.requires).toEqual(["host.usage-limits"]);
    for (const id of [
      "P7.message-compaction-summary",
      "P7.notice-cache-miss",
      "P7.notice-auto-compaction",
    ]) {
      expect(byId.get(id)?.requires).toEqual([]);
    }
    for (const id of [
      "P7.contextGeneral",
      "P7.contextCompaction",
      "P7.contextRulesTtsr",
      "P7.contextExperimental",
    ]) {
      expect(byId.get(id)?.requires).toEqual(["host.config"]);
    }
  });

  test("keeps every fixture scrubbed before it can reach a log or browser test", () => {
    expect(assertP7FixturesAreScrubbed()).toEqual([]);
  });
});
