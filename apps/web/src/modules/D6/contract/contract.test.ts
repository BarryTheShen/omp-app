import { checkScrubbed } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  DiagnosticCommandRequestSchema,
  DiagnosticCommandResultSchema,
  isScrubbedDiagnosticText,
  JobSummarySchema,
  LocalPauseGate,
  RecoveryActionSchema,
  redactDiagnosticLines,
  redactDiagnosticText,
  SecurityFindingSchema,
  SidePanelDescriptorSchema,
} from ".";

describe("D6 diagnostic command and panel contracts", () => {
  test("validates typed diagnostic command results and side-panel descriptors", () => {
    expect(DiagnosticCommandRequestSchema.parse({ name: "security", args: "status" })).toEqual({
      name: "security",
      args: "status",
    });
    const result = DiagnosticCommandResultSchema.parse({
      command: "changelog",
      status: "completed",
      lines: [{ text: "No changes", level: "info", redacted: false }],
      promptSettled: true,
      sessionSettled: true,
      truncated: false,
    });
    expect(result.lines[0]?.text).toBe("No changes");
    const panel = SidePanelDescriptorSchema.parse({
      kind: "panel",
      id: "D6.securityPanel",
      owner: "D6",
      title: "Security",
      covers: ["C1.security"],
      requires: ["host.command-gateway"],
      position: "right",
      readOnly: true,
    });
    expect(panel.position).toBe("right");
  });

  test("preserves bounded security findings and job status without raw secrets", () => {
    expect(
      SecurityFindingSchema.parse({
        id: "finding-1",
        severity: "high",
        title: "Unsafe credential",
        summary: "Redacted summary",
        status: "open",
      }),
    ).toMatchObject({ severity: "high" });
    expect(
      JobSummarySchema.parse({
        id: "job-1",
        label: "Diagnostics",
        status: "running",
        output: [],
        stale: false,
      }).stale,
    ).toBe(false);
  });
});

describe("D6 PauseGate and recovery", () => {
  test("tracks local elapsed pause state and resumes without claiming authority", () => {
    let now = 100;
    const gate = new LocalPauseGate(() => now);
    expect(gate.getSnapshot()).toMatchObject({ open: false, authoritative: false, elapsedMs: 0 });
    gate.open("Waiting for operator recovery");
    now = 450;
    expect(gate.getSnapshot()).toMatchObject({
      open: true,
      elapsedMs: 350,
      authoritative: false,
      reason: "Waiting for operator recovery",
    });
    gate.resume();
    expect(gate.getSnapshot().open).toBe(false);
  });

  test("keeps unavailable recovery actions typed and explicit", () => {
    const action = RecoveryActionSchema.parse({
      id: "reconnect",
      kind: "reconnect",
      label: "Reconnect",
      availability: {
        state: "unavailable",
        capability: "host.reconnect",
        reason: "Reconnect is owned by the host.",
      },
    });
    expect(action.availability.state).toBe("unavailable");
  });
});

describe("D6 redaction", () => {
  test("redacts tokens, private paths and e-mail addresses before DTO creation", () => {
    const fakeKey = ["sk", "ant", "k".repeat(24)].join("-");
    const unsafe = [
      "Bearer",
      "abcdefghijklmnop",
      "/home/user/.omp/config.yml",
      "user@example.com",
      fakeKey,
    ].join(" ");
    const safe = redactDiagnosticText(unsafe);
    expect(safe.redacted).toBe(true);
    expect(isScrubbedDiagnosticText(safe.text)).toBe(true);
    expect(checkScrubbed(safe.text)).toEqual([]);
    expect(safe.text).not.toContain("/home/user");
    expect(safe.text).not.toContain("user@example.com");
  });

  test("bounds diagnostic lines and marks truncation", () => {
    const result = redactDiagnosticLines(
      [{ text: "first" }, { text: "second", level: "warning" }, { text: "third" }],
      2,
    );
    expect(result.lines).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.lines[1]?.level).toBe("warning");
  });
});
