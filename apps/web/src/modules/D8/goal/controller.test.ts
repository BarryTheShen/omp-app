import { AppFailure, type CapabilityMap, RpcSessionEvent, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../R0/store";
import type { ConfirmDialogRequest, DialogRequest, DialogResultFor } from "../../U4/contract";
import type { DialogHostOpenOptions } from "../../U4/contract/dialog-host";
import type {
  AutonomyPort,
  Goal,
  GoalModeState,
  GoalRpcArgs,
  GoalRpcResult,
  GoalStatus,
  GoalUpdatedEvent,
} from "../contract";
import { type ContinuationModesSource, GoalController, type GoalDialogs } from "./controller";
import type { GoalRuntimeStore } from "./runtime";

const threadId = ThreadId.parse("thread-goal");
const availableCapabilities: CapabilityMap = {
  "omp.cmd.goal": { state: "available", via: "rpc" },
};

const otherThreadId = ThreadId.parse("thread-other");
const OMP_WONT_CONTINUE =
  "omp will not continue this goal by itself. Add rpc to Goal Continuation Modes in Settings, Tasks, to let it.";

function makeGoal(
  status: GoalStatus = "active",
  objective = "Keep the project healthy",
  tokenBudget: number | undefined = 4_000,
): Goal {
  return {
    id: "goal-1",
    objective,
    status,
    tokensUsed: 1_200,
    timeUsedSeconds: 45,
    createdAt: 1,
    updatedAt: 2,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

function modeState(goal: Goal): GoalModeState {
  return {
    enabled: goal.status === "active" || goal.status === "budget-limited",
    mode: goal.status === "complete" ? "exiting" : "active",
    goal,
  };
}

function resultFor(goal: Goal | null): GoalRpcResult {
  return { goal, state: goal ? modeState(goal) : null };
}

function makeRuntime(goal: Goal | null, sessionSettled: boolean): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  store.applySessionState({
    goal: goal ? modeState(goal) : null,
    isSettled: sessionSettled,
  });
  return store;
}

function makeAutonomy(initialGoal: Goal | null) {
  let currentGoal = initialGoal;
  const calls: GoalRpcArgs[] = [];
  const listeners = new Set<(event: GoalUpdatedEvent | null) => void>();
  const autonomy: AutonomyPort = {
    async goal(_id, args) {
      calls.push(args);
      switch (args.op) {
        case "get":
          return resultFor(currentGoal);
        case "create":
          currentGoal = makeGoal("active", args.objective ?? "", args.token_budget);
          return resultFor(currentGoal);
        case "pause":
          currentGoal = currentGoal
            ? makeGoal("paused", currentGoal.objective, currentGoal.tokenBudget)
            : null;
          return resultFor(currentGoal);
        case "resume":
          currentGoal = currentGoal
            ? makeGoal("active", currentGoal.objective, currentGoal.tokenBudget)
            : null;
          return resultFor(currentGoal);
        case "drop":
          currentGoal = null;
          return resultFor(currentGoal);
      }
    },
    subscribeGoal(_id, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    autonomy,
    calls,
    emit(goal: Goal | null) {
      currentGoal = goal;
      const event: GoalUpdatedEvent = goal
        ? { type: "goal_updated", goal, state: modeState(goal) }
        : { type: "goal_updated", goal: null };
      for (const listener of listeners) listener(event);
    },
    emitUnreadable() {
      for (const listener of listeners) listener(null);
    },
  };
}

function makeDialogs(
  answers: readonly string[] = [],
  confirmations: readonly boolean[] = [],
  cancelAtRequest?: number,
) {
  const remainingAnswers = [...answers];
  const remainingConfirmations = [...confirmations];
  const requests: DialogRequest[] = [];
  const reviewRequests: ConfirmDialogRequest[] = [];
  const dialogs: GoalDialogs = {
    async open<Request extends DialogRequest>(
      request: Request,
      _options: DialogHostOpenOptions,
    ): Promise<DialogResultFor<Request>> {
      requests.push(request);
      if (requests.length === cancelAtRequest) {
        return { outcome: "cancelled" } as DialogResultFor<Request>;
      }
      const value = remainingAnswers.shift() ?? "";
      if (request.kind === "editor") {
        const response = { outcome: "answered", response: { kind: "editor", value } };
        return response as DialogResultFor<Request>;
      }
      if (request.kind === "input") {
        const response = { outcome: "answered", response: { kind: "input", value } };
        return response as DialogResultFor<Request>;
      }
      throw new Error(`Unexpected dialog kind: ${request.kind}`);
    },
    async confirm(request, _options) {
      reviewRequests.push(request);
      return remainingConfirmations.shift() ?? true;
    },
  };
  return { dialogs, requests, reviewRequests };
}

function makeController(options: {
  readonly goal?: Goal | null;
  readonly settled?: boolean;
  readonly capabilities?: CapabilityMap;
  readonly dialogs?: GoalDialogs;
  readonly continuationModes?: readonly string[] | null;
}) {
  const goal = options.goal ?? null;
  const runtime = makeRuntime(goal, options.settled ?? false);
  const fakeAutonomy = makeAutonomy(goal);
  const dialogFixture = makeDialogs();
  const controller = new GoalController({
    threadId,
    autonomy: fakeAutonomy.autonomy,
    runtime,
    dialogs: options.dialogs ?? dialogFixture.dialogs,
    capabilities: () => options.capabilities ?? availableCapabilities,
    continuationModes: continuationModesSource(options.continuationModes),
  });
  return { controller, runtime, fakeAutonomy, dialogFixture };
}

/** A fixed setting value: omp's default (no rpc) unless a test asks for another. */
function continuationModesSource(
  modes: readonly string[] | null | undefined,
): ContinuationModesSource {
  const value = modes === undefined ? ["interactive"] : modes;
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

/** A runtime whose conversation can change under the controller, as when the person switches thread. */
function makeSwitchingRuntime(initial: OmpRuntimeStore) {
  let current = initial;
  const store: GoalRuntimeStore = {
    getSnapshot: () => current.getSnapshot(),
    subscribe: (listener) => current.subscribe(listener),
    subscribeNotifications: (types, listener) => current.subscribeNotifications(types, listener),
  };
  return {
    store,
    switchTo: (next: OmpRuntimeStore) => {
      current = next;
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("GoalController", () => {
  test("loads goal state, follows settlement and consumes typed goal updates", async () => {
    const goal = makeGoal();
    const { controller, runtime, fakeAutonomy } = makeController({ goal });
    controller.start();
    await flushPromises();

    expect(fakeAutonomy.calls).toContainEqual({ op: "get" });
    expect(controller.getSnapshot().goal?.objective).toBe(goal.objective);
    expect(controller.getSnapshot().continuation?.label).toBe(OMP_WONT_CONTINUE);

    runtime.ingest(
      RpcSessionEvent.parse({ kind: "session_settled", event: { type: "session_settled" } }),
      1,
    );
    expect(controller.getSnapshot().goalState?.sessionSettled).toBe(true);
    expect(controller.getSnapshot().continuation?.label).toBe(OMP_WONT_CONTINUE);

    const pausedGoal = makeGoal("paused");
    fakeAutonomy.emit(pausedGoal);
    expect(controller.getSnapshot().goal?.status).toBe("paused");
    expect(controller.getSnapshot().showPause).toBe(false);
    expect(controller.getSnapshot().showResume).toBe(true);
    controller.dispose();
  });

  test.each([
    {
      status: "paused",
      showCreate: false,
      showPause: false,
      showResume: true,
      showDrop: true,
    },
    {
      status: "budget-limited",
      showCreate: false,
      showPause: true,
      showResume: false,
      showDrop: true,
    },
    {
      status: "complete",
      showCreate: true,
      showPause: false,
      showResume: false,
      showDrop: false,
    },
    {
      status: "dropped",
      showCreate: true,
      showPause: false,
      showResume: false,
      showDrop: false,
    },
  ] as const)("$status goals expose only supported actions", async ({ status, ...expected }) => {
    const { controller } = makeController({ goal: makeGoal(status), settled: true });
    controller.start();
    await flushPromises();

    expect(controller.getSnapshot()).toMatchObject(expected);
    controller.dispose();
  });

  test("reviews a goal and its optional token budget before calling the released create operation", async () => {
    const dialogs = makeDialogs(["  Keep the project healthy  ", "0", "4000"], [true]);
    const { controller, fakeAutonomy } = makeController({
      dialogs: dialogs.dialogs,
      settled: true,
    });
    controller.start();
    await flushPromises();

    await controller.create();

    expect(dialogs.requests.map((request) => request.kind)).toEqual(["editor", "input", "input"]);
    expect(
      dialogs.requests
        .filter((request) => request.kind === "input")
        .map((request) => request.title),
    ).toEqual(["Set a token budget (optional)", "Enter a positive whole number of tokens"]);
    expect(dialogs.reviewRequests[0]?.message).toContain("Objective: Keep the project healthy");
    expect(dialogs.reviewRequests[0]?.message).toContain("Token budget: 4,000 tokens");
    expect(fakeAutonomy.calls).toContainEqual({
      op: "create",
      objective: "Keep the project healthy",
      token_budget: 4000,
    });
    expect(controller.getSnapshot().goal?.objective).toBe("Keep the project healthy");
    expect(controller.getSnapshot().goal?.tokenBudget).toBe(4000);
    controller.dispose();
  });

  test("leaves goal state unchanged when the objective dialog is cancelled", async () => {
    const dialogs = makeDialogs([], [], 1);
    const { controller, fakeAutonomy } = makeController({
      dialogs: dialogs.dialogs,
      settled: true,
    });
    controller.start();
    await flushPromises();

    await controller.create();

    expect(fakeAutonomy.calls).toEqual([{ op: "get" }]);
    expect(controller.getSnapshot()).toMatchObject({
      goal: null,
      pending: null,
      error: null,
    });
    controller.dispose();
  });

  test("pause, resume and drop use released operations and drop requires confirmation", async () => {
    const goal = makeGoal();
    const dialogs = makeDialogs([], [false, true]);
    const { controller, fakeAutonomy } = makeController({
      goal,
      dialogs: dialogs.dialogs,
      settled: true,
    });
    controller.start();
    await flushPromises();

    await controller.pause();
    expect(controller.getSnapshot().goal?.status).toBe("paused");
    await controller.resume();
    expect(controller.getSnapshot().goal?.status).toBe("active");
    await controller.drop();
    expect(fakeAutonomy.calls.some((call) => call.op === "drop")).toBe(false);
    await controller.drop();
    expect(fakeAutonomy.calls.some((call) => call.op === "drop")).toBe(true);
    expect(controller.getSnapshot().goal?.status).toBe("dropped");
    expect(dialogs.reviewRequests).toHaveLength(2);
    controller.dispose();
  });

  test("keeps cached goal details visible while disabling actions when goal RPC is unavailable", async () => {
    const goal = makeGoal();
    const capabilities: CapabilityMap = {
      "omp.cmd.goal": { state: "unavailable", via: "rpc" },
    };
    const { controller, fakeAutonomy } = makeController({ goal, capabilities });
    controller.start();
    await flushPromises();

    expect(controller.getSnapshot().goal?.objective).toBe(goal.objective);
    expect(controller.getSnapshot().capabilityMessage).toBe(
      "Goal actions are unavailable for this connection.",
    );
    expect(controller.getSnapshot().pauseAvailability.state).toBe("unavailable");
    expect(fakeAutonomy.calls).toEqual([]);
    await controller.pause();
    expect(fakeAutonomy.calls).toEqual([]);
    controller.dispose();
  });

  test("a refresh that waits for omp's goal command does not run itself again, in a loop", async () => {
    const goal = makeGoal();
    const fakeAutonomy = makeAutonomy(goal);
    let capabilityReads = 0;
    const controller = new GoalController({
      threadId,
      autonomy: fakeAutonomy.autonomy,
      runtime: makeRuntime(goal, false),
      dialogs: makeDialogs().dialogs,
      capabilities: () => {
        capabilityReads += 1;
        return {};
      },
      continuationModes: continuationModesSource(undefined),
    });
    controller.start();
    await flushPromises();
    // omp has not advertised the goal command: the read waits for the next runtime commit. Each run reads the
    // capabilities a few times; a loop would read them thousands of times before the stack overflows.
    expect(capabilityReads).toBeLessThan(10);
    expect(fakeAutonomy.calls).toEqual([]);
    controller.dispose();
  });

  test("shows omp's own reason when it refuses a goal change", async () => {
    const goal = makeGoal();
    const { controller, fakeAutonomy } = makeController({ goal, settled: true });
    controller.start();
    await flushPromises();
    fakeAutonomy.autonomy.goal = async () => {
      throw new AppFailure({
        code: "omp_error",
        message: "Goal mode is disabled (goal.enabled).",
        retryable: false,
      });
    };

    await controller.pause();

    expect(controller.getSnapshot().error?.message).toBe("Goal mode is disabled (goal.enabled).");
    controller.dispose();
  });

  test("reads the goal again when omp sends an update this app cannot read", async () => {
    const goal = makeGoal();
    const { controller, fakeAutonomy } = makeController({ goal, settled: true });
    controller.start();
    await flushPromises();
    const readsBefore = fakeAutonomy.calls.filter((call) => call.op === "get").length;

    fakeAutonomy.emitUnreadable();
    await flushPromises();

    expect(fakeAutonomy.calls.filter((call) => call.op === "get").length).toBe(readsBefore + 1);
    expect(controller.getSnapshot().goal?.objective).toBe(goal.objective);
    controller.dispose();
  });

  test("shows an RPC failure, then loads the goal when the person tries again", async () => {
    const goal = makeGoal();
    const fake = makeAutonomy(goal);
    let failures = 1;
    const controller = new GoalController({
      threadId,
      autonomy: {
        ...fake.autonomy,
        goal: async (id, args, options) => {
          if (failures > 0) {
            failures -= 1;
            throw new AppFailure({
              code: "unavailable",
              message: "The connection dropped.",
              retryable: true,
            });
          }
          return fake.autonomy.goal(id, args, options);
        },
      },
      runtime: makeRuntime(null, true),
      dialogs: makeDialogs().dialogs,
      capabilities: () => availableCapabilities,
      continuationModes: continuationModesSource(undefined),
    });

    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: "error",
      error: {
        code: "unavailable",
        message: "The goal could not be loaded. Try again.",
        retryable: true,
      },
    });

    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      error: null,
      goal: { objective: goal.objective },
    });
    controller.dispose();
  });

  test("does not apply a goal read that finishes after the selected conversation changed", async () => {
    const goal = makeGoal();
    const fake = makeAutonomy(goal);
    const read = Promise.withResolvers<GoalRpcResult>();
    const runtime = makeSwitchingRuntime(makeRuntime(null, true));
    const controller = new GoalController({
      threadId,
      autonomy: { ...fake.autonomy, goal: () => read.promise },
      runtime: runtime.store,
      dialogs: makeDialogs().dialogs,
      capabilities: () => availableCapabilities,
      continuationModes: continuationModesSource(undefined),
    });

    const refresh = controller.refresh();
    runtime.switchTo(new OmpRuntimeStore({ threadId: otherThreadId }));
    read.resolve(resultFor(goal));
    await refresh;

    expect(controller.getSnapshot()).toMatchObject({
      goal: null,
      error: { code: "conflict" },
    });
    controller.dispose();
  });

  test("ignores an RPC result that arrives after the panel was disposed", async () => {
    const goal = makeGoal();
    const fake = makeAutonomy(goal);
    const read = Promise.withResolvers<GoalRpcResult>();
    let signal: { readonly aborted: boolean } | undefined;
    const controller = new GoalController({
      threadId,
      autonomy: {
        ...fake.autonomy,
        goal: (_id, _args, options) => {
          signal = options?.signal;
          return read.promise;
        },
      },
      runtime: makeRuntime(null, true),
      dialogs: makeDialogs().dialogs,
      capabilities: () => availableCapabilities,
      continuationModes: continuationModesSource(undefined),
    });

    const refresh = controller.refresh();
    const loading = controller.getSnapshot();
    controller.dispose();
    read.resolve(resultFor(goal));
    await refresh;

    expect(signal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toBe(loading);
  });

  test("refuses to create a second goal when one became active while it was being reviewed", async () => {
    const fake = makeAutonomy(null);
    const dialogs = makeDialogs(["Keep the project healthy", "0", "4000"]);
    const controller = new GoalController({
      threadId,
      autonomy: fake.autonomy,
      runtime: makeRuntime(null, true),
      dialogs: {
        open: dialogs.dialogs.open,
        confirm: async (request, options) => {
          fake.emit(makeGoal("active", "A goal someone else started"));
          return dialogs.dialogs.confirm(request, options);
        },
      },
      capabilities: () => availableCapabilities,
      continuationModes: continuationModesSource(undefined),
    });
    controller.start();
    await flushPromises();

    await controller.create();

    expect(fake.calls.some((call) => call.op === "create")).toBe(false);
    expect(controller.getSnapshot().error).toMatchObject({ code: "conflict" });
    controller.dispose();
  });
});
