import type { SettingDescriptor } from "@omp-app/contracts";
import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { S1_DESCRIPTORS, S1_SETTING_DESCRIPTORS, S1_SETTINGS_SECTIONS } from "../../descriptors";
import {
  S1_FIXTURE_COVERAGE,
  S1_OWNED_INVENTORY_ROWS,
  S1_SETTING_INVENTORY_ROWS,
  S1_SURFACE_INVENTORY_ROWS,
} from "../../fixtures";

const sorted = (values: readonly string[]): string[] => [...values].sort();

const S1_INTERACTION_ROWS_NOT_OWNED = [
  "S3.interaction-speech",
  "S3.interaction-stream",
  "S3.interaction-skills",
] as const;

describe("S1.5 descriptor ownership and CC12 gate", () => {
  test("lists exactly the S1 surface and S1-owned S3 interaction inventory rows", () => {
    const contractSurfaceRows = INVENTORY.filter(
      (item) =>
        item.group === "S1" &&
        item.kind !== "setting-group" &&
        item.id !== "S1.plugin-settings-panel",
    ).map((item) => item.id);
    const contractAppearanceRows = INVENTORY.filter(
      (item) => item.group === "S1" && item.kind === "setting-group",
    ).map((item) => item.id);
    const contractInteractionRows = INVENTORY.filter(
      (item) =>
        item.group === "S3" &&
        item.id.startsWith("S3.interaction-") &&
        !S1_INTERACTION_ROWS_NOT_OWNED.includes(
          item.id as (typeof S1_INTERACTION_ROWS_NOT_OWNED)[number],
        ),
    ).map((item) => item.id);

    expect(sorted(S1_SURFACE_INVENTORY_ROWS)).toEqual(sorted(contractSurfaceRows));
    expect(sorted(S1_SETTING_INVENTORY_ROWS)).toEqual(
      sorted([...contractAppearanceRows, ...contractInteractionRows]),
    );
    expect(sorted(S1_OWNED_INVENTORY_ROWS)).toEqual(
      sorted([...contractSurfaceRows, ...contractAppearanceRows, ...contractInteractionRows]),
    );
    expect(new Set(S1_OWNED_INVENTORY_ROWS).size).toBe(18);
    for (const row of S1_INTERACTION_ROWS_NOT_OWNED) {
      expect(S1_OWNED_INVENTORY_ROWS).not.toContain(row);
    }
    expect(S1_OWNED_INVENTORY_ROWS).not.toContain("S1.plugin-settings-panel");
  });

  test("maps all fourteen shared S1.1 sections into owned C0 setting descriptors", () => {
    expect(S1_SETTINGS_SECTIONS).toHaveLength(14);
    expect(S1_SETTING_DESCRIPTORS).toHaveLength(14);
    expect(S1_SETTING_DESCRIPTORS.map((descriptor) => descriptor.section)).toEqual(
      S1_SETTINGS_SECTIONS.map((section) => section.section),
    );
    for (const [index, descriptor] of S1_SETTING_DESCRIPTORS.entries()) {
      const section = S1_SETTINGS_SECTIONS[index];
      const representative = section?.controls[0];
      if (!section || !representative)
        throw new Error("S1 section fixture is missing its first control.");
      expect(descriptor).toMatchObject({
        kind: "setting",
        owner: "S1",
        id: section.id,
        title: expect.any(String),
        key: representative.key,
        section: section.section,
        covers: [...section.inventory],
        requires: [...section.requires],
      });
    }
  });

  test("keeps host-only requirements visible on owned sections", () => {
    expect(S1_SETTINGS_SECTIONS.every((section) => section.requires.includes("host.config"))).toBe(
      true,
    );
    expect(
      S1_SETTINGS_SECTIONS.find((section) => section.section === "interaction/Git")?.requires,
    ).toEqual(["host.config"]);
    expect(
      S1_SETTINGS_SECTIONS.find((section) => section.section === "interaction/Power")?.requires,
    ).toEqual(["host.config"]);
  });

  test("registers the app-local command and three selector dialogs without a fake omp slash command", () => {
    const command = S1_DESCRIPTORS.find(
      (descriptor) => descriptor.kind === "command" && descriptor.id === "S1.settings",
    );
    const dialogs = S1_DESCRIPTORS.filter((descriptor) => descriptor.kind === "dialog");

    expect(command).toMatchObject({
      kind: "command",
      owner: "S1",
      covers: ["S1.settings"],
      requires: ["host.config"],
    });
    if (command?.kind !== "command") throw new Error("Missing app-local settings command.");
    expect(command.slash).toBeUndefined();
    expect(dialogs.map((descriptor) => descriptor.covers[0])).toEqual([
      "S1.settings-selector",
      "S1.theme-selector",
      "S1.show-images-selector",
    ]);
  });

  test("covers every owned row once, has no second claim, and validates against C0", () => {
    const descriptorRows = S1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    const fixtureRows = S1_FIXTURE_COVERAGE.map((coverage) => coverage.inventoryId);
    const settingDescriptors = S1_DESCRIPTORS.filter(
      (descriptor): descriptor is SettingDescriptor => descriptor.kind === "setting",
    );

    expect(sorted(descriptorRows)).toEqual(sorted(S1_OWNED_INVENTORY_ROWS));
    expect(new Set(descriptorRows).size).toBe(descriptorRows.length);
    expect(sorted(fixtureRows)).toEqual(sorted(S1_OWNED_INVENTORY_ROWS));
    expect(new Set(fixtureRows).size).toBe(fixtureRows.length);
    expect(S1_FIXTURE_COVERAGE.every((coverage) => coverage.scenario && coverage.proof)).toBe(true);
    expect(settingDescriptors.every((descriptor) => descriptor.owner === "S1")).toBe(true);
    expect(validateRegistry(S1_DESCRIPTORS)).toEqual([]);
  });
});
