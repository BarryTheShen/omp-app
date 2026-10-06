import {
  ConfigEntry,
  checkScrubbed,
  overridesFollowPrecedence,
  SETTING_SOURCES,
} from "@omp-app/contracts";

import { describe, expect, test } from "vitest";
import { S1_SETTINGS_SECTIONS } from "../../descriptors";
import { S1_PROVENANCE_FIXTURES, S1_SECRET_STATUS_FIXTURES } from "../../fixtures";
import { secretSummary } from "../../settings-kit";

describe("S1.5 ConfigStore provenance and redaction fixtures", () => {
  test("covers every S1 settings group at every omp source and override layer", () => {
    const sources = new Set(S1_PROVENANCE_FIXTURES.map((fixture) => fixture.source));
    expect(SETTING_SOURCES.every((source) => sources.has(source))).toBe(true);
    expect(S1_PROVENANCE_FIXTURES).toHaveLength(S1_SETTINGS_SECTIONS.length * 7);

    for (const fixture of S1_PROVENANCE_FIXTURES) {
      const section = S1_SETTINGS_SECTIONS.find((candidate) => candidate.id === fixture.sectionId);
      if (!section) throw new Error(`Missing S1 fixture section ${fixture.sectionId}.`);
      expect(fixture.snapshot.entries).toHaveLength(section.controls.length);
      for (const rawEntry of fixture.snapshot.entries) {
        const entry = ConfigEntry.parse(rawEntry);
        expect(entry.source).toBe(fixture.source);
        expect(entry.overrides).toEqual(fixture.overrides);
        if (entry.source === "app")
          throw new Error("OMP settings fixtures cannot use the app layer.");
        expect(overridesFollowPrecedence(entry.source, entry.overrides)).toBe(true);
        expect(entry.provenance?.ompVersion).toBe("18.6.1");
      }
    }

    const fallbackEnv = S1_PROVENANCE_FIXTURES.find(
      (fixture) => fixture.source === "global" && fixture.overrides.includes("env"),
    );
    expect(fallbackEnv).toBeDefined();
    expect(overridesFollowPrecedence("global", ["env", "default"])).toBe(true);
    expect(overridesFollowPrecedence("global", ["project", "env"])).toBe(false);

    const projectEntry = S1_PROVENANCE_FIXTURES.find((fixture) => fixture.source === "project")
      ?.snapshot.entries[0];
    const globalEntry = S1_PROVENANCE_FIXTURES.find((fixture) => fixture.source === "global")
      ?.snapshot.entries[0];
    if (!projectEntry || projectEntry.secret || !globalEntry || globalEntry.secret) {
      throw new Error("Missing source-layer provenance fixture.");
    }
    expect(projectEntry.provenance?.path).toBe("<WORKSPACE>/.omp/config.yml");
    expect(globalEntry.provenance?.path).toBe("<HOME>/.omp/agent/config.yml");
    expect(checkScrubbed(JSON.stringify(S1_PROVENANCE_FIXTURES))).toEqual([]);
    expect(checkScrubbed(JSON.stringify(S1_SECRET_STATUS_FIXTURES))).toEqual([]);
  });

  test("set and unset secret fixtures expose only status and safe source", () => {
    expect(S1_SECRET_STATUS_FIXTURES).toHaveLength(2);
    expect(S1_SECRET_STATUS_FIXTURES.map((entry) => entry.isSet)).toEqual([true, false]);

    for (const fixture of S1_SECRET_STATUS_FIXTURES) {
      const entry = ConfigEntry.parse(fixture);
      if (!entry.secret) throw new Error("The secret fixture must be status-only.");
      expect(secretSummary(entry)).toEqual({
        isSecret: true,
        isSet: entry.isSet,
        source: entry.source,
      });
      expect("value" in entry).toBe(false);
      expect(JSON.stringify(entry)).not.toContain("credential-value");
    }
  });
});
