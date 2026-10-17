import { checkScrubbed } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  CleanseProgressSchema,
  DiagnosticCommandResultSchema,
  PauseGateSnapshotSchema,
  RecoveryActionResultSchema,
  SecurityScanStatusSchema,
} from "../contract";
import {
  D6_CLEANSE_PROGRESS_FIXTURE,
  D6_FALLBACK_FIXTURES,
  D6_PAUSE_GATE_FIXTURE,
  D6_RECOVERY_SUCCESS_FIXTURE,
  D6_SECURITY_SCAN_FIXTURE,
  D6_SYNTHETIC_REDACTED_REPORT_FIXTURE,
} from "../fixtures";

describe("D6 scrubbed and fallback fixtures", () => {
  test("synthetic outcomes satisfy the D6 contracts", () => {
    expect(DiagnosticCommandResultSchema.parse(D6_SYNTHETIC_REDACTED_REPORT_FIXTURE)).toEqual(
      D6_SYNTHETIC_REDACTED_REPORT_FIXTURE,
    );
    expect(CleanseProgressSchema.parse(D6_CLEANSE_PROGRESS_FIXTURE)).toEqual(
      D6_CLEANSE_PROGRESS_FIXTURE,
    );
    expect(PauseGateSnapshotSchema.parse(D6_PAUSE_GATE_FIXTURE)).toEqual(D6_PAUSE_GATE_FIXTURE);
    expect(RecoveryActionResultSchema.parse(D6_RECOVERY_SUCCESS_FIXTURE)).toEqual(
      D6_RECOVERY_SUCCESS_FIXTURE,
    );
    expect(SecurityScanStatusSchema.parse(D6_SECURITY_SCAN_FIXTURE)).toEqual(
      D6_SECURITY_SCAN_FIXTURE,
    );
  });

  test("synthetic trace data follows omp's URL shape and is scrubbed", () => {
    const text = JSON.stringify(D6_SYNTHETIC_REDACTED_REPORT_FIXTURE);
    expect(text).toContain("http://127.0.0.1:43120/#/traces?s=%3CREDACTED%3APATH%3E");
    expect(checkScrubbed(text)).toEqual([]);
    expect(text).not.toMatch(/\/home\/|\/Users\/|Bearer\s+[A-Za-z0-9]/);
  });

  test("fallback fixture copy is complete and scrubbed", () => {
    expect(D6_FALLBACK_FIXTURES).toHaveLength(10);
    expect(checkScrubbed(JSON.stringify(D6_FALLBACK_FIXTURES))).toEqual([]);
    for (const fixture of D6_FALLBACK_FIXTURES) {
      expect(fixture.reason).not.toMatch(
        /\/home\/|\/Users\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      );
    }
  });
});
