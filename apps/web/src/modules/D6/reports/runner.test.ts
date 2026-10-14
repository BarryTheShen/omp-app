import {
  type AbortSignalLike,
  AppFailure,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { DiagnosticCommandPort, DiagnosticCommandResult } from "../contract";
import { changelogRequest, TRACE_REQUEST } from "./commands";
import { DiagnosticReportRunner, IDLE_REPORT } from "./runner";

const THREAD: ThreadId = ThreadIdSchema.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

function resultOf(overrides: Partial<DiagnosticCommandResult> = {}): DiagnosticCommandResult {
  return {
    command: "changelog",
    status: "completed",
    lines: [{ text: "one", level: "info", redacted: false }],
    promptSettled: true,
    sessionSettled: true,
    truncated: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function portWith(run: DiagnosticCommandPort["run"]): DiagnosticCommandPort {
  return { run, cancel: vi.fn() };
}

describe("DiagnosticReportRunner", () => {
  test("shows a loading state while omp runs, then omp's lines", async () => {
    const answer = deferred<DiagnosticCommandResult>();
    const runner = new DiagnosticReportRunner(
      portWith(() => answer.promise),
      THREAD,
    );
    const running = runner.run(changelogRequest("recent"), "Changelog");
    expect(runner.getSnapshot()).toMatchObject({ status: "loading", title: "Changelog" });
    answer.resolve(resultOf());
    await running;
    expect(runner.getSnapshot()).toMatchObject({
      status: "ready",
      title: "Changelog",
      lines: [{ text: "one" }],
    });
  });

  test("says a report omp printed nothing for is empty, not an error", async () => {
    const runner = new DiagnosticReportRunner(
      portWith(async () => resultOf({ lines: [] })),
      THREAD,
    );
    await runner.run(changelogRequest("recent"), "Changelog");
    expect(runner.getSnapshot()).toMatchObject({ status: "empty", error: null });
  });

  test("a run that printed no text keeps the note its caller gave", async () => {
    const runner = new DiagnosticReportRunner(
      portWith(async () => resultOf({ lines: [] })),
      THREAD,
    );
    await runner.run(TRACE_REQUEST, "Security: Validate a finding", {
      emptyNote: "omp is checking this finding in the chat; its answer appears there.",
    });
    expect(runner.getSnapshot()).toMatchObject({
      status: "empty",
      note: "omp is checking this finding in the chat; its answer appears there.",
    });
  });

  test("a newer run stops the older one, and the older answer never replaces the newer report", async () => {
    const first = deferred<DiagnosticCommandResult>();
    const second = deferred<DiagnosticCommandResult>();
    const signals: AbortSignalLike[] = [];
    const runs = [first, second];
    const runner = new DiagnosticReportRunner(
      portWith((_thread, _request, options) => {
        if (options?.signal) signals.push(options.signal);
        const next = runs.shift();
        if (next === undefined) throw new Error("unexpected run");
        return next.promise;
      }),
      THREAD,
    );
    const older = runner.run(changelogRequest("recent"), "Changelog");
    const newer = runner.run(TRACE_REQUEST, "Session trace");
    expect(signals[0]?.aborted).toBe(true);
    second.resolve(resultOf({ lines: [{ text: "trace", level: "info", redacted: false }] }));
    await newer;
    first.resolve(resultOf({ lines: [{ text: "stale", level: "info", redacted: false }] }));
    await older;
    expect(runner.getSnapshot()).toMatchObject({
      status: "ready",
      title: "Session trace",
      lines: [{ text: "trace" }],
    });
  });

  test("closing the panel stops waiting for the run in flight and drops its late answer", async () => {
    const answer = deferred<DiagnosticCommandResult>();
    let signal: AbortSignalLike | undefined;
    const runner = new DiagnosticReportRunner(
      portWith((_thread, _request, options) => {
        signal = options?.signal;
        return answer.promise;
      }),
      THREAD,
    );
    const running = runner.run(changelogRequest("recent"), "Changelog");
    runner.close();
    expect(signal?.aborted).toBe(true);
    expect(runner.getSnapshot()).toEqual(IDLE_REPORT);
    answer.resolve(resultOf());
    await running;
    expect(runner.getSnapshot()).toEqual(IDLE_REPORT);
  });

  test("a cancelled run keeps the lines omp printed before it stopped, and says so", async () => {
    const runner = new DiagnosticReportRunner(
      portWith(async () => resultOf({ status: "aborted", promptSettled: false })),
      THREAD,
    );
    await runner.run(changelogRequest("full"), "Changelog");
    expect(runner.getSnapshot()).toMatchObject({
      status: "ready",
      aborted: true,
      promptSettled: false,
      message: "The command was cancelled before it finished.",
      lines: [{ text: "one" }],
    });
  });

  test("a failed run shows omp's reason and keeps no stale lines", async () => {
    const runner = new DiagnosticReportRunner(
      portWith(async () => {
        throw new AppFailure({
          code: "internal",
          message: "omp stopped responding.",
          retryable: true,
        });
      }),
      THREAD,
    );
    await runner.run(TRACE_REQUEST, "Session trace");
    expect(runner.getSnapshot()).toMatchObject({
      status: "error",
      message: "omp stopped responding.",
      lines: [],
      error: { code: "internal", retryable: true },
    });
  });

  test("a gateway that is not available is shown as unavailable, not as an error", async () => {
    const runner = new DiagnosticReportRunner(
      portWith(async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "The command gateway is unavailable.",
          retryable: false,
        });
      }),
      THREAD,
    );
    await runner.run(TRACE_REQUEST, "Session trace");
    expect(runner.getSnapshot()).toMatchObject({
      status: "unavailable",
      message: "The command gateway is unavailable.",
    });
  });

  test("a failure that is not an app error still says plainly that omp could not finish", async () => {
    const runner = new DiagnosticReportRunner(
      portWith(async () => {
        throw new TypeError("socket closed at /home/user/x");
      }),
      THREAD,
    );
    await runner.run(TRACE_REQUEST, "Session trace");
    expect(runner.getSnapshot()).toMatchObject({
      status: "error",
      message: "omp could not finish this report.",
    });
  });
});
