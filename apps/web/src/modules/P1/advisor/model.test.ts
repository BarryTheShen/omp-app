import { ConfigEntry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { AdvisorState } from "../contract";
import {
  ADVISOR_SETTING_DEFINITIONS,
  advisorConfigView,
  advisorNoteView,
  advisorStatusView,
  settingSourceLabel,
} from "./model";

const state: AdvisorState = {
  mode: "on",
  status: "working",
  note: null,
  updatedAt: 1_759_600_000_000,
};

describe("advisor presentation", () => {
  test("shows working status and keeps the on mode separate", () => {
    expect(advisorStatusView(state)).toMatchObject({
      label: "Reviewing",
      detail: "The advisor is reviewing the current turn.",
      modeLabel: "On",
      tone: "warning",
    });
  });

  test("shows delayed note age and named advisor in plain words", () => {
    expect(
      advisorNoteView({
        note: "Check the order",
        severity: "concern",
        advisor: "reviewer",
        turnsAgo: 2,
      }),
    ).toEqual({
      text: "Check the order",
      severityLabel: "Concern",
      ageLabel: "2 turns ago",
      advisorLabel: "reviewer",
    });
  });

  test("builds all eight settings with source and provenance labels", () => {
    const entry = ConfigEntry.parse({
      key: "advisor.enabled",
      secret: false,
      value: true,
      source: "global",
      overrides: ["default"],
      provenance: { origin: "omp-config", ompVersion: "18.9.1" },
    });
    const config = advisorConfigView({
      phase: "ready",
      entries: [{ key: "advisor.enabled", value: entry }],
      layer: "global",
      revision: "rev-2",
      error: null,
    });
    expect(config.rows).toHaveLength(ADVISOR_SETTING_DEFINITIONS.length);
    expect(config.rows[0]).toMatchObject({
      value: true,
      sourceLabel: "Global settings",
      provenanceLabel: "Read from omp settings",
      overridesLabel: "Lower settings also set this",
    });
    expect(settingSourceLabel("project")).toBe("Project settings");
  });

  test("the continue severity setting is omp's: label, ordered values and default", () => {
    // omp v18.12.6 packages/coding-agent/src/advisor/settings.ts:65-84; the values are `ADVISOR_SEVERITIES`
    // (packages/tui/src/chat/messages.ts:290), weakest first.
    const definition = ADVISOR_SETTING_DEFINITIONS.find(
      (candidate) => candidate.key === "advisor.continueSeverity",
    );
    expect(definition).toMatchObject({
      label: "Advisor Continue Severity",
      kind: "select",
      defaultValue: "concern",
    });
    expect(definition?.options).toEqual([
      { value: "nit", label: "Nit" },
      { value: "concern", label: "Concern" },
      { value: "blocker", label: "Blocker" },
    ]);
    expect(definition?.description).not.toContain("`");
    // It sits where omp lists it: after the immune turns, before the review mode.
    const keys = ADVISOR_SETTING_DEFINITIONS.map((candidate) => candidate.key);
    expect(keys.indexOf("advisor.continueSeverity")).toBe(keys.indexOf("advisor.immuneTurns") + 1);
    expect(keys.indexOf("advisor.reviewMode")).toBe(keys.indexOf("advisor.continueSeverity") + 1);
  });
});
