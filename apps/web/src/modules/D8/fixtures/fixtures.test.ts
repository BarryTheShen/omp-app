import { checkScrubbed } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { T5_REAL_RESULTS } from "../../T5/fixtures/real-results";
import { T7_REAL_RESULTS } from "../../T7/fixtures/real-results";
import {
  AP6_UNAVAILABLE_REASONS,
  continuationStatus,
  D8_AP6_CAPABILITIES,
  GoalResultSchema,
  GoalSchema,
} from "../contract";
import { parseTokenBudget } from "../guided/interview";
import {
  AP6_UNAVAILABLE_FIXTURES,
  CONTINUATION_MODE_SETTINGS,
  CREATE_REFUSED_ACTIVE_GOAL,
  GOAL_AVAILABLE,
  GOAL_UNAVAILABLE,
  GUIDED_ANSWERS_SUCCESS,
  GUIDED_CREATE_REQUEST,
  GUIDED_INTERVIEW_CANCELLED,
  GUIDED_INTERVIEW_REFUSED,
  GUIDED_INTERVIEW_SUCCEEDED,
  OMP_WORKER_CAPABILITIES,
  RECORDED_CREATE_REFUSED,
  RECORDED_GOAL_CREATED,
  RECORDED_GOAL_DROPPED,
  RECORDED_WORKERS,
  recordedWorkerRoster,
  SYNTHETIC_RECONNECT_STATES,
  SyntheticReconnectFrameSchema,
  SyntheticReconnectStateSchema,
} from ".";
import reconnectCapture from "./reconnect.synthetic.jsonl?raw";

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

describe("D8 synthetic reconnect fixture", () => {
  test("validates the invented state constants against every parsed synthetic frame", () => {
    const frames = reconnectCapture
      .trim()
      .split("\n")
      .map((line) => SyntheticReconnectFrameSchema.parse(JSON.parse(line)));
    const states = frames
      .filter((frame) => frame.type === "reconnect_state")
      .map((frame) => SyntheticReconnectStateSchema.parse(frame.state));
    expect(states).toEqual(SYNTHETIC_RECONNECT_STATES);
    expect(states).toHaveLength(3);
    expect(
      frames.map((frame) =>
        frame.type === "connection" ? `connection ${frame.state}` : frame.type,
      ),
    ).toEqual([
      "connection open",
      "goal_updated",
      "subagent_lifecycle",
      "command_result",
      "reconnect_state",
      "reconnect_state",
      "reconnect_state",
      "connection closed",
      "connection reconnecting",
      "goal_updated",
      "subagent_lifecycle",
      "command_result",
      "connection open",
    ]);
    expect(frames).toEqual(
      expect.arrayContaining([
        {
          type: "goal_updated",
          goal: {
            id: "goal-1",
            objective: "Measure the reliable response path.",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          seq: 2,
        },
        {
          type: "subagent_lifecycle",
          payload: {
            id: "worker-1",
            agent: "worker",
            agentSource: "bundled",
            status: "completed",
            index: 0,
          },
          seq: 7,
        },
        {
          type: "command_result",
          command: "/ratchet improve the answer flow",
          status: "completed",
          seq: 8,
        },
        { type: "connection", state: "closed", seq: 5 },
        { type: "connection", state: "reconnecting", afterSeq: 5 },
      ]),
    );
  });

  test("checks the goal and worker frames with the app's own schemas, not a local copy", () => {
    const lines = reconnectCapture
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const goal = lines.find((frame) => frame.type === "goal_updated");
    const worker = lines.find((frame) => frame.type === "subagent_lifecycle");

    expect(SyntheticReconnectFrameSchema.safeParse(goal).success).toBe(true);
    expect(SyntheticReconnectFrameSchema.safeParse(worker).success).toBe(true);
    expect(
      SyntheticReconnectFrameSchema.safeParse({ ...goal, goal: { ...goal.goal, tokensUsed: -1 } })
        .success,
    ).toBe(false);
    expect(
      SyntheticReconnectFrameSchema.safeParse({
        ...worker,
        payload: { ...worker.payload, index: -1 },
      }).success,
    ).toBe(false);
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

  test("the reply to the create is the goal method's result, carrying the budget the interview sent", () => {
    const reply = GoalResultSchema.parse(GUIDED_INTERVIEW_SUCCEEDED.createReply);
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
        CREATE_REFUSED_ACTIVE_GOAL,
      ],
      guided: [GUIDED_INTERVIEW_SUCCEEDED, GUIDED_INTERVIEW_CANCELLED, GUIDED_INTERVIEW_REFUSED],
      ap6: AP6_UNAVAILABLE_FIXTURES,
      capabilities: [GOAL_AVAILABLE, GOAL_UNAVAILABLE, OMP_WORKER_CAPABILITIES],
      workers: RECORDED_WORKERS,
      roster: recordedWorkerRoster(),
      reconnectStates: SYNTHETIC_RECONNECT_STATES,
      rawSyntheticReconnectFixture: reconnectCapture,
    });
    expect(checkScrubbed(everything)).toEqual([]);
  });
});
