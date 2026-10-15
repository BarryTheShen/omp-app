import { ConfigEntry, checkScrubbed } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { AgentRefSchema, SubagentTranscriptPageSchema } from "@/modules/P1/contract";
import {
  ADVISOR_ENABLED_ENTRY,
  ADVISOR_ENABLED_WRITE,
  ADVISOR_ENABLED_WRITE_RESULT,
  ADVISOR_NOTE_AGE_CASES,
  ADVISOR_SECTION_KEYS,
  ADVISOR_STALE_WRITE_CONFLICT,
  FIXTURE_THREAD_ID,
  FOCUSED_TRANSCRIPT_PAGE,
  FOCUSED_TRANSCRIPT_ROLES,
  HUB_STATE_FIXTURES,
  OMP_NOT_RUNNING_TEXT,
  P1_CAPABILITY_CASES,
  P1_RETENTION_POLICY,
  PROGRESS_JOIN_SCENARIOS,
  RECORDED_PROGRESS,
  REDACTED_SECRET_STATUS,
  RETENTION_SCENARIOS,
  ROSTER_ORDERING_SCENARIOS,
  SUBAGENT_COMMAND_CASES,
  TRANSCRIPT_CURSOR_SCENARIOS,
} from ".";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A secret-shaped value assembled at runtime, so no key-like literal sits in the source. */
const FAKE_KEY = ["sk", "ant", "k".repeat(30)].join("-");

describe("P1 fixtures: scrubbing and redaction", () => {
  test("no fixture carries a private path, a key, a token or an e-mail address", () => {
    const everything = JSON.stringify({
      ordering: ROSTER_ORDERING_SCENARIOS,
      progress: PROGRESS_JOIN_SCENARIOS,
      retention: RETENTION_SCENARIOS,
      cursor: TRANSCRIPT_CURSOR_SCENARIOS,
      focused: FOCUSED_TRANSCRIPT_PAGE,
      focusedRoles: FOCUSED_TRANSCRIPT_ROLES,
      commands: SUBAGENT_COMMAND_CASES,
      ompNotRunning: OMP_NOT_RUNNING_TEXT,
      settings: [ADVISOR_ENABLED_ENTRY, ADVISOR_ENABLED_WRITE, ADVISOR_ENABLED_WRITE_RESULT],
      sectionKeys: ADVISOR_SECTION_KEYS,
      conflict: ADVISOR_STALE_WRITE_CONFLICT,
      secretStatus: REDACTED_SECRET_STATUS,
      advisorNotes: ADVISOR_NOTE_AGE_CASES,
      capabilities: P1_CAPABILITY_CASES.map((item) => item.map),
      states: HUB_STATE_FIXTURES,
      recorded: RECORDED_PROGRESS,
      thread: FIXTURE_THREAD_ID,
    });

    expect(checkScrubbed(everything)).toEqual([]);
  });

  test("the scrub check catches a secret-shaped value, so the clean result above means something", () => {
    const rules = checkScrubbed(JSON.stringify({ probe: FAKE_KEY })).map((problem) => problem.rule);

    expect(rules).toContain("key");
  });

  test("a secret is described by whether it is set, never by its value", () => {
    expect(REDACTED_SECRET_STATUS).not.toHaveProperty("value");
    expect(ConfigEntry.safeParse({ ...REDACTED_SECRET_STATUS, value: FAKE_KEY }).success).toBe(
      false,
    );
  });

  test("every session file is an absolute .jsonl under the synthetic workspace", () => {
    const files: string[] = [FOCUSED_TRANSCRIPT_PAGE.sessionFile];
    for (const scenario of TRANSCRIPT_CURSOR_SCENARIOS) {
      for (const step of scenario.steps) files.push(step.recordedFile, step.page.sessionFile);
    }
    for (const scenario of [...ROSTER_ORDERING_SCENARIOS, ...PROGRESS_JOIN_SCENARIOS]) {
      for (const step of scenario.steps) {
        if (step.kind === "snapshot") {
          for (const agent of step.agents) {
            if (agent.sessionFile !== undefined) files.push(agent.sessionFile);
          }
        } else if (
          step.event.type !== "subagent_event" &&
          step.event.payload.sessionFile !== undefined
        ) {
          files.push(step.event.payload.sessionFile);
        }
      }
    }
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^\/workspace\/artifacts\/\S+\.jsonl$/);
    }
  });
});

describe("P1 fixtures: retention", () => {
  test("the policy keeps a finished worker 24 hours and at most the newest 100", () => {
    expect(P1_RETENTION_POLICY).toEqual({ tombstoneTtlMs: MS_PER_DAY, tombstoneLimit: 100 });
  });

  test("the burst scenario feeds 101 finished workers and expects the newest 100", () => {
    const burst = RETENTION_SCENARIOS.find((scenario) =>
      scenario.name.startsWith("101 finished workers"),
    );

    expect(burst?.steps).toHaveLength(101);
    expect(burst?.recent).toHaveLength(P1_RETENTION_POLICY.tombstoneLimit);
    expect(burst?.recent[0]?.id).toBe("finished-100");
    expect(burst?.recent.at(-1)?.id).toBe("finished-1");
  });

  test("the window scenarios sit exactly on the 24-hour boundary", () => {
    const window = (name: string): number | undefined => {
      const scenario = RETENTION_SCENARIOS.find((item) => item.name.includes(name));
      const [first, second] = scenario?.steps ?? [];
      return first && second ? second.at - first.at : undefined;
    };

    expect(window("one millisecond before 24 hours")).toBe(MS_PER_DAY - 1);
    expect(window("expires at exactly 24 hours")).toBe(MS_PER_DAY);
  });

  test("no scenario expects more finished workers than the cap", () => {
    for (const scenario of [...ROSTER_ORDERING_SCENARIOS, ...RETENTION_SCENARIOS]) {
      expect(scenario.recent.length).toBeLessThanOrEqual(P1_RETENTION_POLICY.tombstoneLimit);
    }
  });
});

describe("P1 fixtures: contract shapes", () => {
  test("every roster entry in every scenario parses through the contract schema", () => {
    for (const scenario of [...ROSTER_ORDERING_SCENARIOS, ...PROGRESS_JOIN_SCENARIOS]) {
      for (const step of scenario.steps) {
        if (step.kind !== "snapshot") continue;
        for (const agent of step.agents) expect(AgentRefSchema.parse(agent)).toEqual(agent);
      }
    }
  });

  test("every transcript page in every cursor scenario parses through the contract schema", () => {
    for (const scenario of TRANSCRIPT_CURSOR_SCENARIOS) {
      for (const step of scenario.steps) {
        expect(SubagentTranscriptPageSchema.parse(step.page)).toEqual(step.page);
      }
    }
  });
});
