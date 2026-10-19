import {
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { T5_TOOL_DESCRIPTORS } from "./descriptor";
import { T5_REAL_RESULTS } from "./fixtures/real-results";
import {
  decodeHubDetails,
  decodeTaskDetails,
  decodeToolFailure,
  decodeVibeDetails,
  decodeWaitDetails,
  decodeYieldDetails,
  hasT5Capability,
  shownJobText,
  T5CapabilityKeys,
  toT5AppFailure,
  VibeKillArgsSchema,
  VibeListArgsSchema,
  VibeSendArgsSchema,
  VibeSpawnArgsSchema,
  VibeWaitArgsSchema,
} from "./models";
import { alteredDetails, sampleNamed } from "./recorded-props";

/** Whether a recorded result's details decode with the schema of the tool that produced them. */
function decodesAs(toolName: string, details: unknown): boolean {
  if (toolName === "wait") return decodeWaitDetails(details).ok;
  if (toolName === "hub") return decodeHubDetails(details).ok;
  if (toolName === "task") return decodeTaskDetails(details).ok;
  throw new Error(`No T5 decoder for ${toolName}`);
}

describe("T5 coordination and task details", () => {
  test("every recorded wait, hub and task result decodes with its own schema", () => {
    for (const sample of T5_REAL_RESULTS) {
      expect(decodesAs(sample.toolName, sample.result.details), sample.name).toBe(true);
    }
  });

  test("a launch service's log decodes: the logs op is a hub op, not a coordination op", () => {
    expect(
      decodeHubDetails(sampleNamed("hub: the log of a service that is ready").result.details),
    ).toMatchObject({ ok: true, value: { op: "logs", state: "ready", cursor: 17608 } });
  });

  test("keeps fields omp adds later, raw", () => {
    const details = Object.assign(
      {},
      sampleNamed("wait: a message from another agent").result.details,
      {
        futureWaitField: { raw: true },
      },
    );
    expect(decodeWaitDetails(details)).toMatchObject({
      ok: true,
      value: { futureWaitField: { raw: true } },
    });
  });

  test("rejects values outside omp's wire types, so the card shows a visible error", () => {
    expect(
      decodeWaitDetails(
        alteredDetails("wait: a message from another agent", ["waited", "ts"], "now"),
      ).ok,
    ).toBe(false);
    expect(
      decodeHubDetails(
        alteredDetails("hub: a message delivered to one peer", ["receipts", 0, "outcome"], "lost"),
      ).ok,
    ).toBe(false);
    expect(
      decodeWaitDetails(
        alteredDetails(
          "wait: two running tasks and a finished command",
          ["jobs", 0, "status"],
          "paused",
        ),
      ).ok,
    ).toBe(false);
    expect(
      decodeHubDetails(
        alteredDetails("hub: a service that failed to start", ["daemon", "state"], "sleeping"),
      ).ok,
    ).toBe(false);
    expect(
      decodeTaskDetails(
        alteredDetails(
          "task: one agent started in the background",
          ["progress", 0, "status"],
          "paused",
        ),
      ).ok,
    ).toBe(false);
    expect(
      decodeTaskDetails(
        alteredDetails("task: one agent started in the background", ["async", "state"], "paused"),
      ).ok,
    ).toBe(false);
  });
});

describe("T5 vibe and yield models", () => {
  test("accepts vibe and yield details at omp's shapes and keeps unknown fields", () => {
    expect(
      decodeVibeDetails({
        op: "wait",
        wait: {
          settled: [{ id: "session-a", jobId: "job-a", status: "completed" }],
          stillRunning: ["session-b"],
          timedOut: true,
        },
        futureVibeField: ["raw"],
      }),
    ).toMatchObject({ ok: true, value: { futureVibeField: ["raw"] } });
    expect(
      decodeYieldDetails({ status: "aborted", data: { section: 1 }, futureYieldField: 7 }),
    ).toMatchObject({
      ok: true,
      value: { futureYieldField: 7 },
    });
  });

  test("keeps every field of omp's worker screen and the list of killed workers", () => {
    const screen = {
      id: "fast-1",
      cli: "fast",
      state: "running",
      turns: 2,
      queued: 1,
      currentTool: "bash",
      trace: ["read: src/a.ts"],
      outputTail: ["checking"],
      lastActivityAt: 1_759_600_000_000,
      futureScreenField: true,
    };
    expect(
      decodeVibeDetails({ op: "list", screens: [screen], hiddenKilled: ["fast-2"] }),
    ).toMatchObject({ ok: true, value: { screens: [screen], hiddenKilled: ["fast-2"] } });
  });

  test("rejects the shapes an earlier schema assumed, so the card shows a visible error", () => {
    // A boolean for the killed list, ids for settled turns, and screen fields omp never sends.
    expect(decodeVibeDetails({ op: "list", hiddenKilled: true }).ok).toBe(false);
    expect(decodeVibeDetails({ op: "wait", wait: { settled: ["session-a"] } }).ok).toBe(false);
    expect(
      decodeVibeDetails({ op: "list", screens: [{ name: "fast-1", lines: [], updatedAt: 1 }] }).ok,
    ).toBe(false);
  });

  test("decodes the yield details omp really writes: success, last turn, aborted, and a skipped call", () => {
    expect(decodeYieldDetails({ data: { answer: "ready" }, status: "success" })).toMatchObject({
      ok: true,
      value: { status: "success", data: { answer: "ready" } },
    });
    expect(
      decodeYieldDetails({ status: "success", type: "result", useLastTurn: true }),
    ).toMatchObject({ ok: true, value: { useLastTurn: true, type: "result" } });
    expect(
      decodeYieldDetails({ status: "aborted", error: "The shard is missing a row." }),
    ).toMatchObject({
      ok: true,
      value: { status: "aborted", error: "The shard is missing a row." },
    });
    expect(
      decodeYieldDetails({ __synthetic: true, source: "interrupt_skipped", executed: false }),
    ).toMatchObject({ ok: true, value: { source: "interrupt_skipped", executed: false } });
  });

  test("reads the output wrapper's meta on yield details, and rejects an error that is not text", () => {
    expect(
      decodeYieldDetails({
        status: "success",
        data: "x",
        meta: { truncation: { direction: "tail", reason: "lines" } },
      }),
    ).toMatchObject({ ok: true, value: { meta: { truncation: { direction: "tail" } } } });
    expect(decodeYieldDetails({ status: "aborted", error: { message: "not text" } }).ok).toBe(
      false,
    );
  });

  test("validates vibe argument shapes without client execution", () => {
    expect(
      VibeSpawnArgsSchema.safeParse({ cli: "fast", prompt: "inspect", name: "worker-a" }).success,
    ).toBe(true);
    expect(VibeSendArgsSchema.safeParse({ session: "worker-a", message: "status?" }).success).toBe(
      true,
    );
    expect(VibeWaitArgsSchema.safeParse({ sessions: ["worker-a"], timeout: 500 }).success).toBe(
      true,
    );
    expect(VibeKillArgsSchema.safeParse({ session: "worker-a" }).success).toBe(true);
    expect(VibeListArgsSchema.safeParse({}).success).toBe(true);
    expect(VibeSpawnArgsSchema.safeParse({ cli: "unknown", prompt: "inspect" }).success).toBe(
      false,
    );
    // omp's vibe_wait takes a positive number of seconds (tools/vibe.ts:47), and a worker needs a session id.
    expect(VibeWaitArgsSchema.safeParse({ timeout: 0 }).success).toBe(false);
    expect(VibeSendArgsSchema.safeParse({ session: "", message: "status?" }).success).toBe(false);
  });

  test("turns malformed details into typed fallback failures and maps timeout/cancel", () => {
    for (const result of [
      decodeHubDetails(null),
      decodeTaskDetails({ progress: { percent: 101 } }),
      decodeVibeDetails({ wait: { timedOut: "yes" } }),
      decodeYieldDetails({ status: "unknown" }),
      decodeWaitDetails({ jobs: [{ status: "unknown" }] }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AppFailure);
        expect(result.error.appError.code).toBe("invalid_args");
        expect(result.raw).toBeDefined();
      }
    }

    expect(toT5AppFailure({ timedOut: true }).appError).toMatchObject({ code: "timeout" });
    expect(toT5AppFailure({ cancelled: true }).appError).toMatchObject({ code: "cancelled" });
    expect(decodeToolFailure({ code: "unavailable", capability: "omp.subagent-events" }).ok).toBe(
      true,
    );
  });

  test("keeps cards visible while gating only live capabilities", () => {
    const capabilities: CapabilityMap = {
      [T5CapabilityKeys.subagentEvents]: { state: "available", via: "rpc" },
      [T5CapabilityKeys.commandGateway]: { state: "unavailable", via: "host" },
    };
    expect(hasT5Capability(capabilities, T5CapabilityKeys.subagentEvents)).toBe(true);
    expect(hasT5Capability(capabilities, T5CapabilityKeys.commandGateway)).toBe(false);
  });

  test("an unreported subagent capability is unavailable and uses the contract key", () => {
    const contractKey: CapabilityKey = "omp.subagent-events";
    expect(T5CapabilityKeys.subagentEvents).toBe(contractKey);
    expect(hasT5Capability({}, T5CapabilityKeys.subagentEvents)).toBe(false);
  });
});

describe("T5 descriptors", () => {
  test("claims the nine T5 rows and the single P1 task row", () => {
    expect(validateRegistry(T5_TOOL_DESCRIPTORS)).toEqual([]);
    expect(T5_TOOL_DESCRIPTORS).toHaveLength(9);
    expect(T5_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual([
      "T5.hub",
      "T5.task",
      "P1.task-subagent-card",
      "T5.vibe-kill",
      "T5.vibe-list",
      "T5.vibe-send",
      "T5.vibe-spawn",
      "T5.vibe-wait",
      "T5.yield",
      "T5.wait",
    ]);
    expect(T5_TOOL_DESCRIPTORS.find((descriptor) => descriptor.id === "T5.task")?.match).toEqual({
      by: "name",
      name: "task",
    });
  });
});

/** What omp's wait writes for a stopped task: its envelope, then omp's words for the model. */
const STOPPED_TASK =
  '<task-result id="SteerProbe" agent="task" status="cancelled" duration="938ms">\n<meta lines="1" size="0B" />\n<abort-reason>The operation was aborted.</abort-reason>\n<output>\n(no output) after 2 req\n</output>\n</task-result>\n\nSteerProbe was aborted — transcript at history://SteerProbe';

describe("shownJobText", () => {
  test("a stopped task shows its output alone: the envelope, its abort reason and omp's words after it are not shown", () => {
    expect(shownJobText(STOPPED_TASK)).toBe("(no output) after 2 req");
  });

  test("a failed task's error shows the output that ended it, from a recorded wait result", () => {
    const sample = T5_REAL_RESULTS.find(
      (item) => item.name === "wait: a task that failed, with its error",
    );
    const decoded = decodeWaitDetails(sample?.result.details);
    const errorText = decoded.ok ? decoded.value.jobs?.[0]?.errorText : undefined;
    expect(errorText).toContain("<task-result");
    expect(shownJobText(errorText)).toContain("Interrupted OpenAI Codex response");
    expect(shownJobText(errorText)).not.toContain("<task-result");
  });

  test("a preview cut for length shows the preview, and not the path of the full output", () => {
    const cut =
      '<task-result id="X" agent="task" status="completed" duration="1s">\n<preview full-output="agent://X">\nFirst lines.\n</preview>\n</task-result>';
    expect(shownJobText(cut)).toBe("First lines.");
  });

  test("a task that failed after it produced text shows the reason first, then the text it produced", () => {
    const failed =
      '<task-result id="StreamProbe" agent="task" status="failed (exit 1)" duration="2.1s">\n<meta lines="1" size="0B" />\n<error>fake stream failure after the partial answer</error>\n<output>\nPartial answer before the stream failed.\n</output>\n</task-result>';
    expect(shownJobText(failed)).toBe(
      "fake stream failure after the partial answer\n\nPartial answer before the stream failed.",
    );
  });

  test("a task that failed after a cut preview shows the reason, then the preview, and not the path of the full output", () => {
    const failedCut =
      '<task-result id="StreamProbe" agent="task" status="failed (exit 1)" duration="2.1s">\n<error>a reason</error>\n<preview full-output="agent://StreamProbe">\nFirst lines of the text.\n</preview>\n</task-result>';
    expect(shownJobText(failedCut)).toBe("a reason\n\nFirst lines of the text.");
  });

  test("the abort reason stays hidden: a stopped task shows only the output it produced", () => {
    const stopped =
      '<task-result id="SteerProbe" agent="task" status="cancelled" duration="938ms">\n<abort-reason>The operation was aborted.</abort-reason>\n<output>\nPartly done.\n</output>\n</task-result>';
    expect(shownJobText(stopped)).toBe("Partly done.");
  });

  test("an envelope with no output shows nothing, and text without an envelope is shown as it is", () => {
    expect(
      shownJobText(
        '<task-result id="X" agent="task" status="cancelled" duration="1s">\n<abort-reason>Stopped.</abort-reason>\n</task-result>',
      ),
    ).toBeUndefined();
    expect(shownJobText("Plain command output.")).toBe("Plain command output.");
    expect(shownJobText("")).toBeUndefined();
    expect(shownJobText(undefined)).toBeUndefined();
  });
});
