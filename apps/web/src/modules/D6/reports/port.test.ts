import type { AppClient } from "@omp-app/client";
import { AppFailure, type CommandRunResult, OmpCommandGateway, ThreadId } from "@omp-app/contracts";
import { describe, expect, type Mock, test, vi } from "vitest";
import { changelogRequest, jobsRequest, TRACE_REQUEST } from "./commands";
import { createDiagnosticCommandPort, diagnosticResultOf } from "./port";

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

function runOf(overrides: Partial<CommandRunResult> = {}): CommandRunResult {
  return {
    command: "/changelog",
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [],
    sessionUpdates: [],
    configUpdates: [],
    ...overrides,
  };
}

function gatewayClient(run: Mock): Pick<AppClient, "port"> {
  return {
    port: (port: unknown) => {
      if (port !== OmpCommandGateway) throw new Error("the report port uses only the gateway");
      return { run };
    },
  } as unknown as Pick<AppClient, "port">;
}

describe("the report commands", () => {
  test("each report is omp's own slash command, with the full view as an argument", () => {
    expect(changelogRequest("recent")).toEqual({ name: "changelog" });
    expect(changelogRequest("full")).toEqual({ name: "changelog", args: "full" });
    expect(jobsRequest("summary")).toEqual({ name: "jobs" });
    expect(jobsRequest("full")).toEqual({ name: "jobs", args: "full" });
    expect(TRACE_REQUEST).toEqual({ name: "trace" });
  });
});

describe("diagnosticResultOf", () => {
  test("keeps omp's words line by line, blank lines included, and drops only trailing newlines", () => {
    const result = diagnosticResultOf(
      changelogRequest("recent"),
      runOf({ outputs: [{ text: "# Changelog\n\n- one\n\n" }] }),
    );
    expect(result.lines.map((line) => line.text)).toEqual(["# Changelog", "", "- one"]);
    expect(result.status).toBe("completed");
    expect(result.truncated).toBe(false);
  });

  test("hides paths, keys and email addresses, and says which lines it changed", () => {
    const key = ["sk", "ant", "k".repeat(30)].join("-");
    const result = diagnosticResultOf(
      jobsRequest("full"),
      runOf({
        outputs: [
          { text: `  [bg_1] bash (running)\n  ran from /home/user/project\n  key ${key}` },
        ],
      }),
    );
    expect(result.lines.map((line) => [line.text, line.redacted])).toEqual([
      ["  [bg_1] bash (running)", false],
      ["  ran from <REDACTED:PATH>", true],
      ["  key <REDACTED:KEY>", true],
    ]);
  });

  test("keeps at most 500 lines and says the report was cut", () => {
    const text = Array.from({ length: 501 }, (_, index) => `line ${index}`).join("\n");
    const result = diagnosticResultOf(changelogRequest("full"), runOf({ outputs: [{ text }] }));
    expect(result.lines).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  test("passes omp's settlement bits and a cancelled run through without changing them", () => {
    const result = diagnosticResultOf(
      jobsRequest("summary"),
      runOf({ status: "aborted", promptSettled: false, sessionSettled: false }),
    );
    expect(result.status).toBe("aborted");
    expect(result.promptSettled).toBe(false);
    expect(result.sessionSettled).toBe(false);
  });
});

describe("createDiagnosticCommandPort", () => {
  test("sends the report as one slash command through the gateway, with the caller's signal", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(runOf({ command: "/changelog full", outputs: [{ text: "full text" }] }));
    const port = createDiagnosticCommandPort(gatewayClient(run));
    const controller = new AbortController();
    const result = await port.run(THREAD, changelogRequest("full"), {
      signal: controller.signal,
    });
    expect(run).toHaveBeenCalledWith(
      { threadId: THREAD, command: "/changelog full" },
      { signal: controller.signal },
    );
    expect(result.lines.map((line) => line.text)).toEqual(["full text"]);
  });

  test("lets the gateway's failure reach the caller unchanged", async () => {
    const failure = new AppFailure({
      code: "unavailable",
      message: "The command gateway is unavailable.",
      retryable: false,
    });
    const port = createDiagnosticCommandPort(gatewayClient(vi.fn().mockRejectedValue(failure)));
    await expect(port.run(THREAD, TRACE_REQUEST)).rejects.toBe(failure);
  });

  test("refuses to cancel by id, because a run has no id until it settles", async () => {
    const port = createDiagnosticCommandPort(gatewayClient(vi.fn()));
    await expect(port.cancel(THREAD, "diag-1")).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message:
          "A report cannot be stopped by its id. Closing the panel stops waiting for it, but omp still finishes the command.",
      },
    });
  });
});

describe("terminal codes in omp's words", () => {
  test("drop the colour codes omp prints, and keep the words around them", () => {
    const coloured =
      "  System prompt    [\u001b[38;2;107;114;128m░░░░░░░░░░░░░░░░░░░░░░░░\u001b[39m] 2%  2514 tokens";
    const result = diagnosticResultOf({ name: "jobs" }, runOf({ outputs: [{ text: coloured }] }));
    expect(result.lines.map((line) => line.text)).toEqual([
      "  System prompt    [░░░░░░░░░░░░░░░░░░░░░░░░] 2%  2514 tokens",
    ]);
  });
});
