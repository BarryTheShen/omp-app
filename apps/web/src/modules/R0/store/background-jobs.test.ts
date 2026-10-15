import type { MessageKey } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { backgroundJobLaunchTimes, backgroundJobViews } from "./background-jobs";
import type { ProcessState, RuntimeMessage } from "./store";

/** One transcript message, keyed by its position, as the store keeps it. */
function message(id: string, value: Record<string, unknown>): [MessageKey, RuntimeMessage] {
  const key = id as MessageKey;
  return [key, { key, message: value, status: "persisted" } as unknown as RuntimeMessage];
}

/** A bash call omp moved to the background: its tool result, written at `at` (ms). */
function launch(id: string, toolCallId: string, jobId: string, at: number) {
  return message(id, {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [],
    isError: false,
    timestamp: at,
    details: { async: { state: "running", jobId, type: "bash" } },
  });
}

/** omp's notice that a job's result was delivered into the chat, written at `at` (ms). It carries no job status. */
function delivered(id: string, jobId: string, at: number) {
  return message(id, {
    role: "custom",
    customType: "async-result",
    content: "<system-notice>...</system-notice>",
    display: true,
    timestamp: at,
    details: { jobs: [{ jobId, type: "bash" }] },
  });
}

/** A transcript in order: its keys and its messages. */
function transcript(records: readonly (readonly [MessageKey, RuntimeMessage])[]) {
  return {
    order: records.map(([key]) => key),
    messages: Object.fromEntries(records) as Record<MessageKey, RuntimeMessage>,
  };
}

function process(status: ProcessState["status"], startedAt?: number): ProcessState {
  return startedAt === undefined ? { status, error: null } : { status, error: null, startedAt };
}

function viewsOf(
  records: readonly (readonly [MessageKey, RuntimeMessage])[],
  current: ProcessState,
): Record<string, unknown> {
  const { order, messages } = transcript(records);
  return Object.fromEntries(backgroundJobViews(order, messages, current));
}

describe("background job views", () => {
  test("a job whose result came back is finished", () => {
    expect(
      viewsOf(
        [launch("1", "call_a", "bg_1", 100), delivered("2", "bg_1", 200)],
        process("ready", 50),
      ),
    ).toEqual({ call_a: { kind: "finished", jobId: "bg_1" } });
  });

  test("a job with no result, launched by the process that runs now, is running", () => {
    expect(viewsOf([launch("1", "call_a", "bg_1", 100)], process("ready", 50))).toEqual({
      call_a: { kind: "running", jobId: "bg_1" },
    });
  });

  test("a job launched before the process that runs now started has ended, with no result to show", () => {
    expect(viewsOf([launch("1", "call_a", "bg_1", 100)], process("ready", 150))).toEqual({
      call_a: { kind: "ended", jobId: "bg_1" },
    });
  });

  test("with no process running, a job with no result has ended", () => {
    expect(viewsOf([launch("1", "call_a", "bg_1", 100)], process("exited", 50))).toEqual({
      call_a: { kind: "ended", jobId: "bg_1" },
    });
    expect(viewsOf([launch("1", "call_a", "bg_1", 100)], process("restarting", 50))).toEqual({
      call_a: { kind: "ended", jobId: "bg_1" },
    });
  });

  test("a live process that has not said when it started leaves its jobs unknown", () => {
    expect(viewsOf([launch("1", "call_a", "bg_1", 100)], process("ready"))).toEqual({
      call_a: { kind: "unknown", jobId: "bg_1" },
    });
  });

  test("a result goes to the nearest earlier launch with its job id, so a relaunched id does not finish an older job", () => {
    // Process A launched bg_1 and died before it finished; process B (started at 250) launched bg_1 again and it finished.
    expect(
      viewsOf(
        [
          launch("1", "call_a", "bg_1", 100),
          launch("2", "call_b", "bg_1", 300),
          delivered("3", "bg_1", 400),
        ],
        process("ready", 250),
      ),
    ).toEqual({
      call_a: { kind: "ended", jobId: "bg_1" },
      call_b: { kind: "finished", jobId: "bg_1" },
    });
  });

  test("a result for an earlier job does not finish a later launch with the same id", () => {
    expect(
      viewsOf(
        [
          launch("1", "call_a", "bg_1", 100),
          delivered("2", "bg_1", 200),
          launch("3", "call_b", "bg_1", 300),
        ],
        process("ready", 250),
      ),
    ).toEqual({
      call_a: { kind: "finished", jobId: "bg_1" },
      call_b: { kind: "running", jobId: "bg_1" },
    });
  });

  test("a result with no launch before it finishes nothing", () => {
    expect(
      viewsOf(
        [delivered("1", "bg_9", 100), launch("2", "call_a", "bg_9", 200)],
        process("ready", 50),
      ),
    ).toEqual({ call_a: { kind: "running", jobId: "bg_9" } });
  });

  test("only bash calls that omp moved to the background are jobs", () => {
    expect(
      viewsOf(
        [
          message("1", {
            role: "toolResult",
            toolCallId: "call_task",
            toolName: "task",
            content: [],
            isError: false,
            timestamp: 100,
            details: { async: { state: "running", jobId: "bg_1", type: "task" } },
          }),
          message("2", {
            role: "toolResult",
            toolCallId: "call_plain",
            toolName: "bash",
            content: [],
            isError: false,
            timestamp: 100,
            details: { wallTimeMs: 3 },
          }),
        ],
        process("ready", 50),
      ),
    ).toEqual({});
  });

  test("each job keeps its own view", () => {
    expect(
      viewsOf(
        [
          launch("1", "call_a", "bg_1", 100),
          launch("2", "call_b", "bg_2", 110),
          delivered("3", "bg_2", 200),
        ],
        process("ready", 50),
      ),
    ).toEqual({
      call_a: { kind: "running", jobId: "bg_1" },
      call_b: { kind: "finished", jobId: "bg_2" },
    });
  });
});

describe("backgroundJobLaunchTimes", () => {
  test("gives each background bash call the time its launch result was written, and no time to other results", () => {
    const { order, messages } = transcript([
      launch("m1", "call_a", "bg_1", 1_000),
      message("m2", {
        role: "toolResult",
        toolCallId: "call_b",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: 1_500,
        details: {},
      }),
      launch("m3", "call_c", "bg_2", 2_000),
    ]);
    expect(backgroundJobLaunchTimes(order, messages)).toEqual(
      new Map([
        ["call_a", 1_000],
        ["call_c", 2_000],
      ]),
    );
  });
});
