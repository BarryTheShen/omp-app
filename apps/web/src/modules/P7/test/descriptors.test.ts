import { INVENTORY, uncoveredInventory, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { P7_COMMAND_DESCRIPTORS } from "../commands/descriptors";
import {
  P7_DESCRIPTORS,
  P7_MESSAGE_DESCRIPTORS,
  P7_NOTICE_DESCRIPTORS,
  P7_SETTING_DESCRIPTORS,
  P7_STATUS_DESCRIPTORS,
} from "../descriptors";
import { P7_INVENTORY_ROWS } from "../fixtures";

const sorted = (values: readonly string[]): string[] => [...values].sort();
const P7_GROUPS = ["P4", "E4", "S4"] as const;

describe("P7 CC12 inventory and descriptor gate", () => {
  test("claims every P4, E4 and S4 inventory row exactly once across P7's descriptors", () => {
    const liveRows = INVENTORY.filter((item) =>
      (P7_GROUPS as readonly string[]).includes(item.group),
    ).map((item) => item.id);
    const covered = P7_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);

    expect(sorted(P7_INVENTORY_ROWS)).toEqual(sorted(liveRows));
    expect(liveRows).toHaveLength(28);
    expect(sorted(covered)).toEqual(sorted(liveRows));
    expect(new Set(covered).size).toBe(covered.length);
  });

  test("leaves no P4, E4 or S4 row uncovered by the registry", () => {
    const uncovered = uncoveredInventory(P7_DESCRIPTORS).filter((id) => {
      const group = INVENTORY.find((item) => item.id === id)?.group ?? "";
      return (P7_GROUPS as readonly string[]).includes(group);
    });
    expect(uncovered).toEqual([]);
  });

  test("splits the rows by the part that owns each one, with no row in two parts", () => {
    const commandRows = P7_COMMAND_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    const settingRows = P7_SETTING_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    const ownRows = [
      ...P7_STATUS_DESCRIPTORS,
      ...P7_MESSAGE_DESCRIPTORS,
      ...P7_NOTICE_DESCRIPTORS,
    ].flatMap((descriptor) => descriptor.covers);

    expect(sorted(commandRows)).toEqual(
      sorted([
        "E4.compact",
        "E4.compact-remote",
        "E4.compact-snapcompact",
        "E4.compact-soft",
        "P4.context",
        "P4.stats",
        "P4.usage-command",
        "P4.usage-reset",
        "P4.usage-show",
      ]),
    );
    expect(sorted(settingRows)).toEqual([
      "S4.context-compaction",
      "S4.context-experimental",
      "S4.context-general",
      "S4.context-rules-ttsr",
    ]);
    expect(ownRows).toHaveLength(15);
    const parts = [...commandRows, ...settingRows, ...ownRows];
    expect(new Set(parts).size).toBe(parts.length);
  });

  test("passes the C0 registry validator with no problem", () => {
    expect(validateRegistry(P7_DESCRIPTORS)).toEqual([]);
  });

  test("names every descriptor P7.* and owned by P7", () => {
    for (const descriptor of P7_DESCRIPTORS) {
      expect(descriptor.owner).toBe("P7");
      expect(descriptor.id.startsWith("P7.")).toBe(true);
    }
    const ids = P7_DESCRIPTORS.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("gives each S4 section one setting descriptor keyed by its first control", () => {
    expect(P7_SETTING_DESCRIPTORS.map((descriptor) => descriptor.section)).toEqual([
      "context/General",
      "context/Compaction",
      "context/Rules (TTSR)",
      "context/Experimental",
    ]);
    for (const descriptor of P7_SETTING_DESCRIPTORS) {
      expect(descriptor.covers).toHaveLength(1);
      expect(descriptor.requires).toEqual(["host.config"]);
      expect(descriptor.key.length).toBeGreaterThan(0);
    }
  });

  test("keeps the one command, status, message and notice kinds each part uses", () => {
    expect(P7_STATUS_DESCRIPTORS.every((descriptor) => descriptor.kind === "status")).toBe(true);
    expect(P7_MESSAGE_DESCRIPTORS.map((descriptor) => descriptor.match)).toEqual([
      { by: "role", role: "compactionSummary" },
    ]);
    expect(P7_NOTICE_DESCRIPTORS.every((descriptor) => descriptor.severity === "info")).toBe(true);
  });
});
