import { validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { S3_DESCRIPTORS, S3_SETTINGS_SECTIONS } from "../../descriptors";

const EXPECTED_INVENTORY = [
  "S5.tools-available-tools",
  "S5.tools-grep-browser",
  "S5.tools-computer",
  "S5.tools-github",
  "S5.tools-output-limits",
  "S5.tools-execution",
  "S5.tools-extensions",
  "S5.tools-developer",
  "S5.tools-ida-pro",
  "S5.tools-todos",
  "S5.tasks-commands-skills",
  "S5.tasks-isolation",
  "S5.tasks-modes",
  "S5.tasks-subagents",
] as const;

describe("S3 settings descriptor handoff", () => {
  test("re-exports all fourteen S1.1 sections without an adapter schema", () => {
    expect(S3_SETTINGS_SECTIONS).toHaveLength(EXPECTED_INVENTORY.length);
    expect(S3_SETTINGS_SECTIONS.flatMap((section) => section.inventory).sort()).toEqual(
      [...EXPECTED_INVENTORY].sort(),
    );
    expect(S3_SETTINGS_SECTIONS.every((section) => section.requires.includes("host.config"))).toBe(
      true,
    );
  });

  test("maps one C0 setting descriptor to each section and validates S3 ownership", () => {
    expect(S3_DESCRIPTORS).toHaveLength(EXPECTED_INVENTORY.length);
    expect(validateRegistry(S3_DESCRIPTORS)).toEqual([]);
    expect(S3_DESCRIPTORS.every((descriptor) => descriptor.owner === "S3")).toBe(true);
    expect(S3_DESCRIPTORS.every((descriptor) => descriptor.kind === "setting")).toBe(true);
    expect(S3_DESCRIPTORS.flatMap((descriptor) => descriptor.covers).sort()).toEqual(
      [...EXPECTED_INVENTORY].sort(),
    );

    for (const section of S3_SETTINGS_SECTIONS) {
      const descriptor = S3_DESCRIPTORS.find((candidate) => candidate.id === section.id);
      const representative = section.controls[0];
      if (!descriptor || !representative)
        throw new Error(`Missing S3 setting descriptor ${section.id}.`);
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
