import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { S2_DESCRIPTORS, S2_SETTINGS_SECTIONS } from "../../descriptors";

/** The six Files and Shell groups, with the key count omp's inventory gives each (packages/contracts/src/core/inventory.json). */
const INVENTORY_GROUPS = [
  ["S5.files-editing", 9], // "Files / Editing (9)"
  ["S5.files-reading", 4], // "Files / Reading (4)"
  ["S5.files-read-summaries", 7], // "Files / Read Summaries (7)"
  ["S5.files-lsp", 7], // "Files / LSP (7)"
  ["S5.shell-bash", 9], // "Shell / Bash (9)"
  ["S5.shell-eval-runtimes", 8], // "Shell / Eval & Runtimes (8)"
] as const;

describe("S2.4 settings descriptor exports", () => {
  test("re-exports six S1.1 sections, one per inventory group, each with the key count omp's inventory gives it", () => {
    expect(
      Object.fromEntries(
        S2_SETTINGS_SECTIONS.map((section) => [section.inventory.join(), section.controls.length]),
      ),
    ).toEqual(Object.fromEntries(INVENTORY_GROUPS));
  });

  test("every section names one inventory row and requires the host config", () => {
    for (const section of S2_SETTINGS_SECTIONS) {
      expect(section.inventory, section.id).toHaveLength(1);
      expect(section.requires, section.id).toEqual(["host.config"]);
    }
  });

  test("maps one C0 setting claim to each section, owned by S2, covering exactly the six inventory rows", () => {
    expect(S2_DESCRIPTORS).toHaveLength(S2_SETTINGS_SECTIONS.length);
    expect(validateRegistry(S2_DESCRIPTORS)).toEqual([]);
    expect(S2_DESCRIPTORS.every((descriptor) => descriptor.owner === "S2")).toBe(true);
    expect(S2_DESCRIPTORS.every((descriptor) => descriptor.kind === "setting")).toBe(true);
    expect(S2_DESCRIPTORS.flatMap((descriptor) => descriptor.covers).sort()).toEqual(
      INVENTORY_GROUPS.map(([row]) => row).sort(),
    );

    for (const section of S2_SETTINGS_SECTIONS) {
      const descriptor = S2_DESCRIPTORS.find((candidate) => candidate.id === section.id);
      const representative = section.controls[0];
      if (!descriptor || !representative) {
        throw new Error(`Missing S2 setting descriptor ${section.id}.`);
      }
      expect(descriptor).toMatchObject({
        id: section.id,
        title: section.title,
        section: section.section,
        key: representative.key,
        covers: section.inventory,
        requires: section.requires,
      });
    }
  });
});
