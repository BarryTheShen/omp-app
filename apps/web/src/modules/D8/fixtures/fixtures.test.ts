import { checkScrubbed, parseFixture, RpcSessionEvent } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { T5_REAL_RESULTS } from "../../T5/fixtures/real-results";
import { T7_REAL_RESULTS } from "../../T7/fixtures/real-results";
import {
  AP6_UNAVAILABLE_REASONS,
  continuationStatus,
  D8_AP6_CAPABILITIES,
  GoalRpcResultSchema,
  GoalSchema,
  GoalUpdatedEventSchema,
} from "../contract";
import { parseTokenBudget } from "../guided/interview";
import {
  AP6_UNAVAILABLE_FIXTURES,
  CONTINUATION_MODE_SETTINGS,
  GOAL_RPC_AVAILABLE,
  GOAL_RPC_UNAVAILABLE,
  GUIDED_ANSWERS_SUCCESS,
  GUIDED_CREATE_REQUEST,
  GUIDED_INTERVIEW_CANCELLED,
  GUIDED_INTERVIEW_REFUSED,
  GUIDED_INTERVIEW_SUCCEEDED,
  OMP_WORKER_CAPABILITIES,
  RECORDED_CREATE_REFUSED,
  RECORDED_GOAL_CREATED,
  RECORDED_GOAL_DROPPED,
  RECORDED_GOAL_RPC,
  RECORDED_GOAL_UPDATED,
  RECORDED_RATCHET_GATEWAY,
  RECORDED_WORKERS,
  RPC_CREATE_REFUSED_ACTIVE_GOAL,
  recordedWorkerRoster,
} from ".";
import goalCapture from "./goal-rpc.capture.jsonl?raw";
import ratchetCapture from "./ratchet.capture.jsonl?raw";

function recordedResult(name: string) {
  const found = [...T7_REAL_RESULTS, ...T5_REAL_RESULTS].find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no recorded result named ${name}`);
  return found;
}

describe("D8 fixtures are copies of results omp already recorded", () => {
  test("the goal values are the goal objects of the recorded goal tool results", () => {
    expect(recordedResult(RECORDED_GOAL_CREATED.name)).toMatchObject({
      result: { details: { goal: RECORDED_GOAL_CREATED.value } },
    });
    expect(recordedResult(RECORDED_GOAL_DROPPED.name)).toMatchObject({
      result: { details: { goal: RECORDED_GOAL_DROPPED.value } },
    });
  });

  test("the tool refusal is the recorded error text", () => {
    expect(recordedResult(RECORDED_CREATE_REFUSED.name)).toMatchObject({
      isError: true,
      result: { content: [{ text: RECORDED_CREATE_REFUSED.value }] },
    });
  });

  test("each wait job and the task progress record are omp's own records", () => {
    for (const worker of RECORDED_WORKERS.filter((item) => item.name.startsWith("wait:"))) {
      expect(recordedResult(worker.name)).toMatchObject({
        result: {
          details: { jobs: expect.arrayContaining([expect.objectContaining(worker.value)]) },
        },
      });
    }
    const started = RECORDED_WORKERS.find((item) => item.value.id === "BuilderTwo");
    if (started === undefined) throw new Error("no BuilderTwo fixture");
    expect(recordedResult(started.name)).toMatchObject({
      result: {
        details: { progress: expect.arrayContaining([expect.objectContaining(started.value)]) },
      },
    });
  });
});

describe("D8 ratchet gateway recording", () => {
  test("captures the full request and kickoff turn in a canonical fixture", () => {
    const parsedFixture = parseFixture(ratchetCapture);
    if (!parsedFixture.ok) throw new Error(parsedFixture.error.message);
    expect(parsedFixture.value.header).toMatchObject({
      scenario: "d8-ratchet-kickoff",
      omp: { version: "18.8.9", mode: "rpc-ui", protocolVersion: 2 },
      provider: { kind: "fake-openai" },
    });
    const frames: Array<Record<string, unknown> & { readonly dir: "stdin" | "stdout" }> =
      parsedFixture.value.frames.map(({ dir, line }) => ({
        ...z.record(z.string(), z.unknown()).parse(JSON.parse(line)),
        dir,
      }));
    const request = frames.find((frame) => frame.dir === "stdin" && frame.type === "prompt");
    const command = z.string().parse(request?.message);
    expect(command).toMatch(/^\/ratchet /u);
    const stdoutFrames = frames
      .filter((frame) => frame.dir === "stdout")
      .map(({ dir: _dir, ...frame }) => frame);
    expect(stdoutFrames.find((frame) => frame.type === "ready")).toMatchObject({
      protocolVersion: 1,
      supportedProtocolVersions: expect.arrayContaining([1, 2]),
    });
    const response = stdoutFrames.find(
      (frame) => frame.type === "response" && frame.command === "prompt",
    );
    expect(response).toMatchObject({ success: true });
    expect(stdoutFrames.find((frame) => frame.type === "prompt_result")).toMatchObject({
      agentInvoked: true,
    });
    expect(stdoutFrames.find((frame) => frame.type === "session_settled")).toBeDefined();

    const kickoffMessage = (type: "message_start" | "message_end") => {
      const frame = stdoutFrames.find((item) => {
        if (item.type !== type || typeof item.message !== "object" || item.message === null)
          return false;
        return "role" in item.message && item.message.role === "user";
      });
      return z
        .object({
          role: z.literal("user"),
          content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
        })
        .passthrough()
        .parse(frame?.message);
    };
    const kickoffStart = kickoffMessage("message_start");
    const kickoffEnd = kickoffMessage("message_end");
    expect(kickoffStart).toEqual(kickoffEnd);
    const kickoffText = kickoffStart.content[0]?.text;
    expect(kickoffText).toContain("`/ratchet`: build");
    expect(kickoffText).toContain(
      `<ratchet-request>\n${command.slice("/ratchet ".length)}\n</ratchet-request>`,
    );

    const promptResult = RpcSessionEvent.parse({
      kind: "prompt_result",
      event: stdoutFrames.find((frame) => frame.type === "prompt_result"),
    });
    expect(promptResult.kind).toBe("prompt_result");
    if (promptResult.kind === "prompt_result") {
      expect(promptResult.event).toMatchObject({
        agentInvoked: true,
        status: "completed",
        sessionSettled: true,
      });
    }
    expect(stdoutFrames.findIndex((frame) => frame.type === "session_settled")).toBeGreaterThan(
      stdoutFrames.findIndex((frame) => frame.type === "prompt_result"),
    );
  });
});

describe("D8 goal RPC recording", () => {
  test("compares every typed goal constant against the raw RPC frame it records", () => {
    const frames = goalCapture
      .trim()
      .split("\n")
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    const frameWithId = (id: string) => {
      const frame = frames.find((candidate) => candidate.id === id);
      if (frame === undefined) throw new Error(`no captured frame ${id}`);
      return frame;
    };
    const responseFor = (id: string) => frameWithId(id).data;
    for (const [id, expected] of Object.entries({
      "goal-create": RECORDED_GOAL_RPC.create,
      "goal-get": RECORDED_GOAL_RPC.get,
      "goal-pause": RECORDED_GOAL_RPC.pause,
      "goal-resume": RECORDED_GOAL_RPC.resume,
      "goal-get-2": RECORDED_GOAL_RPC.afterAbort,
      "goal-drop": RECORDED_GOAL_RPC.drop,
      "goal-get-3": RECORDED_GOAL_RPC.afterDrop,
    })) {
      const result = responseFor(id);
      expect(result).toEqual(expected);
      expect(GoalRpcResultSchema.parse(result)).toEqual(expected);
    }
    const abortResponse = frameWithId("abort");
    expect(abortResponse).toEqual({
      id: "abort",
      type: "response",
      command: "abort",
      success: true,
    });
    const promptResult = frames.find((frame) => frame.type === "prompt_result");
    const parsedPromptResult = RpcSessionEvent.parse({
      kind: "prompt_result",
      event: promptResult,
    });
    if (parsedPromptResult.kind !== "prompt_result") {
      throw new Error("captured prompt result did not parse as a prompt-result event");
    }
    expect(parsedPromptResult.event).toMatchObject({
      id: "prompt",
      agentInvoked: true,
      status: "aborted",
      sessionSettled: true,
    });
    const sessionSettled = frames.find((frame) => frame.type === "session_settled");
    const parsedSessionSettled = RpcSessionEvent.parse({
      kind: "session_settled",
      event: sessionSettled,
    });
    if (parsedSessionSettled.kind !== "session_settled") {
      throw new Error("captured settlement did not parse as a session-settled event");
    }
    expect(parsedSessionSettled.event).toEqual({ type: "session_settled" });
    const rawUpdates = frames.filter((frame) => frame.type === "goal_updated");
    expect(rawUpdates).toEqual(RECORDED_GOAL_UPDATED);
    for (const event of rawUpdates) {
      expect(GoalUpdatedEventSchema.parse(event)).toBeDefined();
    }
  });
});

describe("D8 fixtures match the contract schemas", () => {
  test("the goals parse as released goals", () => {
    expect(GoalSchema.parse(RECORDED_GOAL_CREATED.value)).toEqual(RECORDED_GOAL_CREATED.value);
    expect(GoalSchema.parse(RECORDED_GOAL_DROPPED.value)).toEqual(RECORDED_GOAL_DROPPED.value);
  });

  test("the guided create request carries the five headings, the attempt cap and the budget", () => {
    expect(GUIDED_CREATE_REQUEST.token_budget).toBe(5000);
    expect(parseTokenBudget(GUIDED_ANSWERS_SUCCESS.budget)).toEqual({
      ok: true,
      tokenBudget: 5000,
    });
    const headings = GUIDED_CREATE_REQUEST.objective
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## Objective",
      "## Success criteria",
      "## Verification",
      "## Boundaries",
      "## Stop conditions",
    ]);
    expect(GUIDED_CREATE_REQUEST.objective).toContain("Attempt cap: 3");
  });

  test("the reply to the create is omp's RPC shape, carrying the budget the interview sent", () => {
    const reply = GoalRpcResultSchema.parse(GUIDED_INTERVIEW_SUCCEEDED.createReply);
    expect(reply.goal?.tokenBudget).toBe(GUIDED_CREATE_REQUEST.token_budget);
    expect(reply.goal?.status).toBe("active");
    expect(reply.state).toBeNull();
  });

  test("every AP6 seam is unavailable with its reason and a typed failure", () => {
    for (const fixture of AP6_UNAVAILABLE_FIXTURES) {
      expect(fixture.status).toEqual({
        state: "unavailable",
        via: "upstream",
        detail: AP6_UNAVAILABLE_REASONS[fixture.feature],
      });
      expect(fixture.failure.appError).toMatchObject({
        code: "unavailable",
        retryable: false,
        capability: fixture.capability,
      });
    }
    expect(AP6_UNAVAILABLE_FIXTURES.map((fixture) => fixture.capability).sort()).toEqual(
      Object.values(D8_AP6_CAPABILITIES).sort(),
    );
  });

  test("the continuation line follows omp's setting, and a dropped goal has none", () => {
    expect(
      continuationStatus(RECORDED_GOAL_CREATED.value, CONTINUATION_MODE_SETTINGS.withRpc)?.label,
    ).toBe("omp keeps working on this goal by itself.");
    expect(
      continuationStatus(RECORDED_GOAL_CREATED.value, CONTINUATION_MODE_SETTINGS.withoutRpc)?.label,
    ).toContain("will not continue this goal by itself");
    expect(
      continuationStatus(RECORDED_GOAL_CREATED.value, CONTINUATION_MODE_SETTINGS.unreadable)?.label,
    ).toContain("cannot tell");
    expect(
      continuationStatus(RECORDED_GOAL_DROPPED.value, CONTINUATION_MODE_SETTINGS.withRpc),
    ).toBeNull();
  });
  test("a budget-limited goal does not say omp keeps working on it (#1693)", () => {
    const budgetLimited = GoalSchema.parse({
      ...RECORDED_GOAL_CREATED.value,
      status: "budget-limited",
      tokenBudget: 5000,
    });
    expect(continuationStatus(budgetLimited, CONTINUATION_MODE_SETTINGS.withRpc)?.label).toBe(
      "omp stops continuing this goal because it reached its token budget.",
    );
  });

  test("only the task progress record names an agent source; the wait jobs' sources are unknown", () => {
    const roster = recordedWorkerRoster();
    expect(roster.agents["ScoutOne:0"]?.agentSource).toBe("unknown");
    expect(roster.agents["ScoutTwo:0"]?.agentSource).toBe("unknown");
    expect(roster.agents["ScoutThree:0"]?.agentSource).toBe("unknown");
    expect(roster.agents["BuilderTwo:0"]?.agentSource).toBe("bundled");
  });
});

describe("D8 fixtures are scrubbed", () => {
  test("no fixture carries a private path, a key or an e-mail address", () => {
    const everything = JSON.stringify({
      goals: [
        RECORDED_GOAL_CREATED,
        RECORDED_GOAL_DROPPED,
        RECORDED_CREATE_REFUSED,
        RPC_CREATE_REFUSED_ACTIVE_GOAL,
        RECORDED_GOAL_RPC,
        RECORDED_GOAL_UPDATED,
      ],
      ratchet: [RECORDED_RATCHET_GATEWAY, ratchetCapture],
      guided: [GUIDED_INTERVIEW_SUCCEEDED, GUIDED_INTERVIEW_CANCELLED, GUIDED_INTERVIEW_REFUSED],
      ap6: AP6_UNAVAILABLE_FIXTURES,
      capabilities: [GOAL_RPC_AVAILABLE, GOAL_RPC_UNAVAILABLE, OMP_WORKER_CAPABILITIES],
      workers: RECORDED_WORKERS,
      roster: recordedWorkerRoster(),
      rawCapture: goalCapture,
      rawRatchetCapture: ratchetCapture,
    });
    expect(checkScrubbed(everything)).toEqual([]);
  });
});
