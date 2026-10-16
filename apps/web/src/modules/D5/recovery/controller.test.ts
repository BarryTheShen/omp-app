import { AppFailure, type CapabilityMap, CommandRunResult, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ProcessState } from "../../R0/store";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type { HandoffRequest, HandoffResult } from "../contract";
import { RecoveryController, type RecoveryControllerOptions } from "./controller";
import realHandoff from "./fixtures/real-handoff.json";

const threadId = ThreadId.parse("thread-d54-controller");
const readyProcess: ProcessState = { status: "ready", error: null };
const readyCapabilities: CapabilityMap = {
  "omp.cmd.handoff": { state: "available", via: "rpc" },
  "host.command-gateway": { state: "available", via: "host" },
};
function runOf(agentInvoked: boolean): CommandRunResult {
  return CommandRunResult.parse({
    command: "/retry",
    status: "completed",
    agentInvoked,
    promptSettled: true,
    sessionSettled: true,
    outputs: [],
    sessionUpdates: [],
    configUpdates: [],
  });
}
const savedHandoff: HandoffResult = {
  savedPath: null,
  summaryEntryId: null,
  sessionSettled: true,
};

interface Overrides {
  confirm: () => Promise<boolean>;
  createHandoff: (request?: HandoffRequest) => Promise<HandoffResult>;
  run: () => Promise<CommandRunResult>;
}

interface Harness {
  readonly controller: RecoveryController;
  readonly handoffCalls: HandoffRequest[];
  readonly confirms: string[];
  readonly gatewayCalls: unknown[];
  readonly restored: string[];
  readonly refreshes: string[];
  setSession(id: ThreadId): void;
  setCapabilities(map: CapabilityMap): void;
  setProcess(state: ProcessState): void;
  setStreaming(value: boolean): void;
}

function harness(overrides: Partial<Overrides> = {}): Harness {
  let session = threadId;
  let capabilities = readyCapabilities;
  let process = readyProcess;
  let streaming = false;
  const handoffCalls: HandoffRequest[] = [];
  const confirms: string[] = [];
  const gatewayCalls: unknown[] = [];
  const restored: string[] = [];
  const refreshes: string[] = [];

  const dialogs = {
    confirm: (request: { readonly title: string }) => {
      confirms.push(request.title);
      return (overrides.confirm ?? (() => Promise.resolve(true)))();
    },
  } as unknown as Pick<DialogHost, "confirm">;
  const options: RecoveryControllerOptions = {
    session: { getSnapshot: () => ({ id: session }) },
    handoff: {
      createHandoff: (request) => {
        handoffCalls.push(request ?? {});
        return (overrides.createHandoff ?? (() => Promise.resolve(savedHandoff)))(request);
      },
    },
    gateway: {
      run: (args: unknown) => {
        gatewayCalls.push(args);
        return (overrides.run ?? (() => Promise.resolve(runOf(true))))();
      },
    } as unknown as RecoveryControllerOptions["gateway"],
    dialogs,
    capabilities: { getSnapshot: () => capabilities },
    process: { getSnapshot: () => process },
    prompt: { getSnapshot: () => ({ streaming }) },
    afterHandoff: () => {
      refreshes.push("refresh");
      return Promise.resolve();
    },
  };
  return {
    controller: new RecoveryController(options),
    handoffCalls,
    confirms,
    gatewayCalls,
    restored,
    refreshes,
    setSession: (id) => {
      session = id;
    },
    setCapabilities: (map) => {
      capabilities = map;
    },
    setProcess: (state) => {
      process = state;
    },
    setStreaming: (value) => {
      streaming = value;
    },
  };
}

describe("RecoveryController availability", () => {
  test("says why a command is unavailable when the connection has no capability for it", () => {
    const h = harness();
    h.setCapabilities({});

    expect(h.controller.getAvailability("handoff")).toEqual({
      state: "unavailable",
      capability: "omp.cmd.handoff",
      reason: "Handing off this conversation is unavailable for this connection.",
    });
    expect(h.controller.getAvailability("retry")).toEqual({
      state: "unavailable",
      capability: "host.command-gateway",
      reason: "Retrying the failed reply is unavailable for this connection.",
    });
  });

  test("uses the capability's own detail as the reason when the connection gives one", () => {
    const h = harness();
    h.setCapabilities({
      "omp.cmd.handoff": { state: "unavailable", via: "rpc", detail: "This omp has no handoff." },
    });

    expect(h.controller.getAvailability("handoff")).toMatchObject({
      state: "unavailable",
      reason: "This omp has no handoff.",
    });
  });

  test("keeps both commands unavailable while omp has stopped, with a plain reason", () => {
    const h = harness();
    h.setProcess({ status: "exited", error: null });
    expect(h.controller.getAvailability("handoff")).toMatchObject({
      state: "unavailable",
      reason: "omp stopped. Start it again to continue.",
    });

    h.setProcess({
      status: "error",
      error: { code: "omp_exited", message: "omp crashed.", retryable: true },
    });
    expect(h.controller.getAvailability("handoff")).toMatchObject({
      state: "unavailable",
      reason: "omp crashed.",
    });
  });
});

describe("RecoveryController handoff", () => {
  test("hands off after the person confirms, with their focus, and refreshes the transcript once", async () => {
    const h = harness();

    const outcome = await h.controller.handoff({ customInstructions: "Keep the plan." });

    expect(outcome).toEqual({ status: "completed", value: savedHandoff });
    expect(h.handoffCalls).toEqual([{ customInstructions: "Keep the plan." }]);
    expect(h.confirms).toEqual(["Hand off this conversation?"]);
    expect(h.refreshes).toEqual(["refresh"]);
    expect(h.controller.getState().handoff).toEqual({ status: "done", outcome: "completed" });
  });

  test("does nothing and gives the draft back when the person declines the confirmation", async () => {
    const h = harness({ confirm: () => Promise.resolve(false) });

    const outcome = await h.controller.handoff(
      {},
      { restoreDraft: () => h.restored.push("draft") },
    );

    expect(outcome).toEqual({ status: "cancelled" });
    expect(h.handoffCalls).toEqual([]);
    expect(h.refreshes).toEqual([]);
    expect(h.restored).toEqual(["draft"]);
    expect(h.controller.getState().handoff).toEqual({ status: "done", outcome: "cancelled" });
  });

  test("shows omp's own refusal as the error, gives the draft back, and does not refresh", async () => {
    const refusal = realHandoff.handoff.rpcRefusalNothingToHandOff.replace(/^AppFailure: /, "");
    const h = harness({
      createHandoff: () =>
        Promise.reject(new AppFailure({ code: "omp_error", message: refusal, retryable: false })),
    });

    const outcome = await h.controller.handoff(
      {},
      { restoreDraft: () => h.restored.push("draft") },
    );

    expect(outcome).toEqual({
      status: "error",
      error: { code: "omp_error", message: refusal, retryable: false },
    });
    expect(h.restored).toEqual(["draft"]);
    expect(h.refreshes).toEqual([]);
    expect(h.controller.getState().handoff).toEqual({
      status: "done",
      outcome: "error",
      message: refusal,
    });
  });

  test("shows a handoff that made nothing as a failure, not as a success, and gives the draft back", async () => {
    const h = harness({
      createHandoff: () =>
        Promise.reject(
          new AppFailure({
            code: "unavailable",
            message: "No handoff was made.",
            retryable: false,
          }),
        ),
    });

    const outcome = await h.controller.handoff(
      {},
      { restoreDraft: () => h.restored.push("draft") },
    );

    expect(outcome).toEqual({
      status: "error",
      error: { code: "unavailable", message: "No handoff was made.", retryable: false },
    });
    expect(h.refreshes).toEqual([]);
    expect(h.restored).toEqual(["draft"]);
  });

  test("reads a cancelled failure as a cancelled handoff, not an error", async () => {
    const h = harness({
      createHandoff: () =>
        Promise.reject(
          new AppFailure({ code: "cancelled", message: "Stopped.", retryable: false }),
        ),
    });

    expect(await h.controller.handoff()).toEqual({ status: "cancelled" });
  });

  test("shows a plain sentence for a failure that is not an AppFailure, never its raw message", async () => {
    const h = harness({ createHandoff: () => Promise.reject(new Error("The socket closed.")) });

    expect(await h.controller.handoff()).toEqual({
      status: "error",
      error: { code: "internal", message: "The handoff did not finish.", retryable: false },
    });
  });

  test("refuses to hand off into a session the person has left during the confirmation", async () => {
    const h = harness({
      confirm: () => {
        h.setSession(ThreadId.parse("thread-d54-other"));
        return Promise.resolve(true);
      },
    });

    const outcome = await h.controller.handoff();

    expect(outcome).toMatchObject({ status: "error", error: { code: "conflict" } });
    expect(h.handoffCalls).toEqual([]);
  });

  test("does not confirm or hand off while omp is stopped, and gives the draft back", async () => {
    const h = harness();
    h.setProcess({ status: "stopped", error: null });

    const outcome = await h.controller.handoff(
      {},
      { restoreDraft: () => h.restored.push("draft") },
    );

    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(h.confirms).toEqual([]);
    expect(h.handoffCalls).toEqual([]);
    expect(h.restored).toEqual(["draft"]);
  });

  test("refuses to hand off while a reply streams, before it asks, and says to wait", async () => {
    const h = harness();
    h.setStreaming(true);

    const outcome = await h.controller.handoff(
      {},
      { restoreDraft: () => h.restored.push("draft") },
    );

    expect(outcome).toEqual({
      status: "unavailable",
      error: {
        code: "conflict",
        message: "Wait for the current reply to finish, then hand off the conversation.",
        retryable: true,
      },
    });
    expect(h.confirms).toEqual([]);
    expect(h.restored).toEqual(["draft"]);
  });
});

describe("RecoveryController retry", () => {
  test("runs /retry through the command gateway for the open thread and returns the run it started", async () => {
    const h = harness();

    const outcome = await h.controller.retry();

    expect(outcome).toEqual({ status: "completed", value: runOf(true) });
    expect(h.gatewayCalls).toEqual([{ threadId, command: "/retry" }]);
    expect(h.controller.getState().retry).toEqual({ status: "done", outcome: "completed" });
  });

  test("says there is no failed reply when omp started no turn, which is what it answers then", async () => {
    const h = harness({ run: () => Promise.resolve(runOf(false)) });

    const outcome = await h.controller.retry();

    expect(outcome).toEqual({
      status: "unavailable",
      error: {
        code: "unavailable",
        message: "There is no failed reply to retry.",
        retryable: false,
      },
    });
    expect(h.controller.getState().retry).toEqual({
      status: "done",
      outcome: "unavailable",
      message: "There is no failed reply to retry.",
    });
  });

  test("refuses to retry while a reply streams, without sending the command", async () => {
    const h = harness();
    h.setStreaming(true);

    const outcome = await h.controller.retry();

    expect(outcome).toEqual({
      status: "unavailable",
      error: {
        code: "conflict",
        message: "Wait for the current reply to finish, then try again.",
        retryable: true,
      },
    });
    expect(h.gatewayCalls).toEqual([]);
  });

  test("says when a reply began while the retry was on its way, and does not call it nothing to retry", async () => {
    const h = harness({
      run: () => {
        h.setStreaming(true);
        return Promise.resolve(runOf(false));
      },
    });

    const outcome = await h.controller.retry();

    expect(outcome).toMatchObject({
      status: "unavailable",
      error: { code: "conflict", message: "Wait for the current reply to finish, then try again." },
    });
  });

  test("shows omp's provider refusal of the retry as the error, as omp words it", async () => {
    const refusal = String(realHandoff.retry.rpcRefusalProviderError).replace(/^AppFailure: /, "");
    const h = harness({
      run: () =>
        Promise.reject(new AppFailure({ code: "omp_error", message: refusal, retryable: false })),
    });

    const outcome = await h.controller.retry();

    expect(outcome).toMatchObject({ status: "error", error: { code: "omp_error" } });
    expect(refusal.startsWith("401 Invalid API key")).toBe(true);
    expect(h.controller.getState().retry).toMatchObject({ status: "done", outcome: "error" });
  });

  test("shows a plain sentence for a retry failure that is not an AppFailure", async () => {
    const h = harness({ run: () => Promise.reject(new TypeError("undefined is not a function")) });

    expect(await h.controller.retry()).toEqual({
      status: "error",
      error: {
        code: "internal",
        message: "Retrying the failed reply did not finish.",
        retryable: false,
      },
    });
  });
});

describe("RecoveryController one command at a time", () => {
  test("refuses a retry while a handoff waits for its confirmation, and the retry never reaches omp", async () => {
    let answer: ((confirmed: boolean) => void) | undefined;
    const h = harness({
      confirm: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });

    const handoff = h.controller.handoff();
    const retry = await h.controller.retry();

    expect(retry).toEqual({
      status: "unavailable",
      error: {
        code: "conflict",
        message: "Wait for the current action to finish.",
        retryable: true,
      },
    });
    expect(h.gatewayCalls).toEqual([]);
    answer?.(false);
    expect(await handoff).toEqual({ status: "cancelled" });
  });
});

describe("RecoveryController state", () => {
  test("keeps one state object until a phase changes, and tells subscribers about each change", async () => {
    const h = harness();
    let notified = 0;
    const off = h.controller.subscribe(() => {
      notified += 1;
    });
    const before = h.controller.getState();

    expect(h.controller.getState()).toBe(before);
    await h.controller.handoff();
    expect(h.controller.getState()).not.toBe(before);
    expect(notified).toBeGreaterThan(0);

    const count = notified;
    off();
    await h.controller.retry();
    expect(notified).toBe(count);
  });
});
