import { AppFailure, type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { ConfirmDialogRequest, DialogRequest, DialogResultFor } from "../../U4/contract";
import type { DialogHostOpenOptions } from "../../U4/contract/dialog-host";
import type {
  AutonomyPort,
  Goal,
  GoalModeState,
  GoalRpcArgs,
  GoalRpcResult,
  GoalStatus,
} from "../contract";
import type { GuidedComposerDraft } from "./composer";
import { GuidedGoalController, type GuidedGoalSource } from "./controller";

const threadId = ThreadId.parse("thread-guided");
const availableCapabilities: CapabilityMap = {
  "omp.cmd.goal": { state: "available", via: "omp" },
};

/** The six required answers, in the order the interview asks them. */
const SIX = [
  "Ship the parser",
  "All tests pass",
  "bun run test",
  "5 attempts",
  "Only src/parser",
  "Stop on a failing migration",
] as const;

const GOAL_TEXT = "Ship the parser, reviewed";
const GOAL_TEXT_WITH_BUDGET = `${GOAL_TEXT}\n\nToken budget: 5000 tokens`;
const CREATED_NOTICE = "Goal created. omp works on it once you send a message.";

/** A reply that answers the dialog, or closes it without an answer. */
type Answered = { readonly answer: string } | { readonly closed: true; readonly draft?: string };

/** What the next dialog does: an answered or closed reply, or a hold until the test resolves it. */
type Reply = Answered | { readonly hold: true };

const answer = (value: string): Answered => ({ answer: value });
const closed = (draft?: string): Answered =>
  draft === undefined ? { closed: true } : { closed: true, draft };
const HOLD: Reply = { hold: true };

/** What the next confirmation does: answers, fails to show, runs an action first, or waits until the test says. */
type ConfirmReply = boolean | AppFailure | "hold" | (() => boolean);

function goalOf(status: GoalStatus): Goal {
  return {
    id: "goal-1",
    objective: GOAL_TEXT,
    status,
    tokensUsed: 1_200,
    timeUsedSeconds: 45,
    createdAt: 1,
    updatedAt: 2,
  };
}

function stateOf(status: GoalStatus, enabled: boolean): GoalModeState {
  return { enabled, mode: "active", goal: goalOf(status) };
}

/** The answers that run the interview to its review: the six, then the budget, then the reviewed goal text. */
function interviewReplies(budget: string, review: string): Reply[] {
  return [...SIX.map(answer), answer(budget), answer(review)];
}

interface HarnessOptions {
  readonly composer?: string;
  readonly state?: GoalModeState | null;
  readonly unavailable?: boolean;
  readonly restoreFocus?: () => void;
  /** One outcome per create: `ok`, or the failure omp or the connection gave. */
  readonly creates?: readonly ("ok" | AppFailure)[];
}

/** One controller wired to scripted dialogs, a scripted omp, a goal state the test can change, and a message box. */
function makeHarness(options: HarnessOptions = {}) {
  const queue: Reply[] = [];
  const confirmQueue: ConfirmReply[] = [];
  const requests: DialogRequest[] = [];
  const confirmations: ConfirmDialogRequest[] = [];
  const optionsSeen: DialogHostOpenOptions[] = [];
  const goalArgs: GoalRpcArgs[] = [];
  const createOutcomes = [...(options.creates ?? [])];
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  // Resolved as soon as a dialog is held open, so a test can wait for that without a timer.
  const parked = Promise.withResolvers<void>();
  let box = options.composer ?? "";
  let state: GoalModeState | null = options.state ?? null;
  let resolveOpen: ((reply: Answered) => void) | null = null;
  let resolveConfirm: ((value: boolean) => void) | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const setState = (next: GoalModeState | null) => {
    state = next;
    notify();
  };

  const toResult = (request: DialogRequest, reply: Answered) => {
    if ("closed" in reply) {
      return {
        outcome: "cancelled" as const,
        kind: request.kind,
        timedOut: false,
        ...(reply.draft === undefined ? {} : { draft: reply.draft }),
      };
    }
    const kind = request.kind === "input" ? "input" : "editor";
    return { outcome: "answered" as const, response: { kind, value: reply.answer } };
  };

  const dialogs = {
    open<Request extends DialogRequest>(
      request: Request,
      options: DialogHostOpenOptions,
    ): Promise<DialogResultFor<Request>> {
      requests.push(request);
      optionsSeen.push(options);
      const reply = queue.shift();
      if (reply === undefined) {
        throw new Error(`No reply was scripted for the ${request.kind} dialog.`);
      }
      if ("hold" in reply) {
        parked.resolve();
        return new Promise((resolve) => {
          resolveOpen = (next) => resolve(toResult(request, next) as DialogResultFor<Request>);
        });
      }
      return Promise.resolve(toResult(request, reply) as DialogResultFor<Request>);
    },
    async confirm(request: ConfirmDialogRequest, options: DialogHostOpenOptions): Promise<boolean> {
      confirmations.push(request);
      optionsSeen.push(options);
      const reply = confirmQueue.shift();
      if (reply === undefined) throw new Error("No confirmation was scripted.");
      if (reply === "hold") {
        parked.resolve();
        return new Promise((resolve) => {
          resolveConfirm = resolve;
        });
      }
      if (reply instanceof AppFailure) throw reply;
      if (typeof reply === "function") return reply();
      return reply;
    },
  };

  const autonomy: AutonomyPort = {
    async goal(_threadId, args) {
      goalArgs.push(args);
      const outcome = createOutcomes.shift() ?? "ok";
      if (outcome !== "ok") throw outcome;
      setState(stateOf("active", true));
      return { goal: state?.goal ?? null, state } as GoalRpcResult;
    },
    subscribeGoal: () => () => undefined,
  };

  const goal: GuidedGoalSource = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const composer: GuidedComposerDraft = {
    read: () => box,
    write: async (text) => {
      writes.push(text);
      box = text;
    },
  };
  const controller = new GuidedGoalController({
    threadId,
    autonomy,
    dialogs,
    capabilities: () => (options.unavailable ? {} : availableCapabilities),
    goal,
    restoreFocus: options.restoreFocus,
    composer,
  });
  return {
    controller,
    requests,
    confirmations,
    optionsSeen,
    goalArgs,
    writes,
    box: () => box,
    /** The person types in the message box: not a write by the interview. */
    typeIntoBox: (text: string) => {
      box = text;
    },
    setState,
    reply: (...next: Reply[]) => queue.push(...next),
    confirmReply: (...next: ConfirmReply[]) => confirmQueue.push(...next),
    /** Resolves once a dialog is held open. */
    untilHeld: () => parked.promise,
    resolveHeld: (reply: Answered) => {
      const resolve = resolveOpen;
      resolveOpen = null;
      resolve?.(reply);
    },
    resolveHeldConfirm: (value: boolean) => {
      const resolve = resolveConfirm;
      resolveConfirm = null;
      resolve?.(value);
    },
  };
}

describe("guided goal controller: the dialogs and the goal", () => {
  test("asks the six questions, the budget and the review, then creates one goal with the reviewed text", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("5000", GOAL_TEXT));
    h.confirmReply(true);

    await h.controller.start();

    expect(h.requests.map((request) => request.kind)).toEqual([
      "editor",
      "editor",
      "editor",
      "editor",
      "editor",
      "editor",
      "input",
      "editor",
    ]);
    expect(h.requests[6]).toMatchObject({ kind: "input", title: "Token budget (optional)" });
    expect(h.requests[7]).toMatchObject({
      kind: "editor",
      prefill: expect.stringContaining(
        "## Stop conditions\nAttempt cap: 5 attempts\nStop on a failing migration",
      ),
    });
    expect(h.requests.every((request) => request.id.startsWith("app-d8-guided-"))).toBe(true);
    expect(h.optionsSeen.every((options) => options.origin === "app")).toBe(true);
    expect(h.goalArgs).toEqual([{ op: "create", objective: GOAL_TEXT, token_budget: 5000 }]);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "created",
      error: null,
      notice: CREATED_NOTICE,
    });
    expect(h.writes).toEqual([]);
    expect(h.box()).toBe("");
  });
  test("passes the dialog focus restore callback through to every app dialog", async () => {
    const restoreFocus = vi.fn();
    const h = makeHarness({ restoreFocus });
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);

    await h.controller.start();

    expect(h.optionsSeen).toHaveLength(9);
    expect(h.optionsSeen.every((options) => options.restoreFocus === restoreFocus)).toBe(true);
  });

  test("a confirmation is always asked before the create, and a declined one creates nothing", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);

    await h.controller.start();

    expect(h.confirmations).toHaveLength(1);
    expect(h.goalArgs).toEqual([]);
  });
});

describe("guided goal controller: text kept when a dialog closes without an answer", () => {
  test("cancelling a question with text typed keeps the answers so far and that text in the message box", async () => {
    const h = makeHarness();
    h.reply(answer(SIX[0]), answer(SIX[1]), closed("Verify with"));

    await h.controller.start();

    expect(h.goalArgs).toEqual([]);
    expect(h.box()).toBe(
      [
        "What should omp get done?",
        "Ship the parser",
        "",
        "How will you know it is done?",
        "All tests pass",
        "",
        "What should omp run to check its own work?",
        "Verify with",
      ].join("\n"),
    );
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "cancelled",
      notice: "Interview cancelled. No goal was created. Your answers are in the message box.",
    });
  });

  test("cancelling with nothing typed keeps nothing", async () => {
    const h = makeHarness();
    h.reply(closed(""));

    await h.controller.start();

    expect(h.writes).toEqual([]);
    expect(h.box()).toBe("");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "cancelled",
      notice: "Interview cancelled. No goal was created.",
    });
  });

  test("declining the confirmation puts the reviewed goal and its budget in the message box", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("5000", GOAL_TEXT));
    h.confirmReply(false);

    await h.controller.start();

    expect(h.goalArgs).toEqual([]);
    expect(h.writes).toEqual([GOAL_TEXT_WITH_BUDGET]);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "cancelled",
      notice: "Interview cancelled. No goal was created. The goal text is in the message box.",
    });
  });

  test("text already in the message box is kept, and the goal text follows it", async () => {
    const h = makeHarness({ composer: "Draft line" });
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);

    await h.controller.start();

    expect(h.box()).toBe(`Draft line\n\n${GOAL_TEXT}`);
  });

  test("cancelling the review editor keeps the person's edits to the objective as the goal text", async () => {
    const h = makeHarness();
    h.reply(...SIX.map(answer), answer(""), closed("Ship the parser, edited"));

    await h.controller.start();

    expect(h.box()).toBe("Ship the parser, edited");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "cancelled",
      notice: "Interview cancelled. No goal was created. The goal text is in the message box.",
    });
  });

  test("cancelling the review with the objective cleared keeps the answers instead", async () => {
    const h = makeHarness();
    h.reply(...SIX.map(answer), answer(""), closed(""));

    await h.controller.start();

    expect(h.box()).toBe(
      [
        "What should omp get done?",
        "Ship the parser",
        "",
        "How will you know it is done?",
        "All tests pass",
        "",
        "What should omp run to check its own work?",
        "bun run test",
        "",
        "How many attempts may omp make before it stops?",
        "5 attempts",
        "",
        "What may omp change, and what must it leave alone?",
        "Only src/parser",
        "",
        "When should omp stop and ask you?",
        "Stop on a failing migration",
      ].join("\n"),
    );
  });

  test("an invalid token budget keeps the entry in the box, and cancelling the reopened budget replaces it", async () => {
    const h = makeHarness();
    h.reply(...SIX.map(answer), answer("0"), closed(""));

    await h.controller.start();

    // The budget is the seventh dialog; the reopened budget, with the reason, is the eighth.
    expect(h.requests[7]).toMatchObject({
      kind: "input",
      title: "Enter a token budget above zero, or leave this blank.",
    });
    expect(h.box()).not.toContain("Token budget (optional)\n0");
    expect(h.box()).toBe(
      [
        "What should omp get done?",
        "Ship the parser",
        "",
        "How will you know it is done?",
        "All tests pass",
        "",
        "What should omp run to check its own work?",
        "bun run test",
        "",
        "How many attempts may omp make before it stops?",
        "5 attempts",
        "",
        "What may omp change, and what must it leave alone?",
        "Only src/parser",
        "",
        "When should omp stop and ask you?",
        "Stop on a failing migration",
      ].join("\n"),
    );
    expect(h.writes).toHaveLength(2);
  });

  test("a dialog cancelled again replaces the entry it held before, rather than standing beside it", async () => {
    const h = makeHarness();
    h.reply(answer(SIX[0]), answer(SIX[1]), closed("Verify with"));
    await h.controller.start();

    h.reply(answer(SIX[0]), answer(SIX[1]), closed("Verify with more"));
    await h.controller.start();

    expect(h.box().split("What should omp run to check its own work?")).toHaveLength(2);
    expect(h.box()).toContain("What should omp run to check its own work?\nVerify with more");
    expect(h.writes).toHaveLength(2);
  });
});

describe("guided goal controller: one block in the box, never stacked", () => {
  test("a later write replaces the goal text kept earlier, rather than adding a second block", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);
    await h.controller.start();
    expect(h.writes).toEqual([GOAL_TEXT]);

    h.reply(closed(SIX[0]));
    await h.controller.start();

    expect(h.box()).not.toContain(GOAL_TEXT);
    expect(h.box()).toContain("What should omp get done?\nShip the parser");
    expect(h.writes).toHaveLength(2);
  });

  test("a repeat of the same goal text is not written again", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);
    await h.controller.start();

    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);
    await h.controller.start();

    expect(h.writes).toEqual([GOAL_TEXT]);
    expect(h.box()).toBe(GOAL_TEXT);
  });

  test("a failed create keeps the goal text once, and a second failed Try again does not add it again", async () => {
    const failure = new AppFailure({
      code: "unavailable",
      message: "The connection dropped.",
      retryable: true,
    });
    const h = makeHarness({ creates: [failure, failure, "ok"] });
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(true);

    await h.controller.start();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "failed",
      error: { code: "unavailable", message: "The goal could not be created.", retryable: true },
    });
    expect(h.box()).toBe(GOAL_TEXT);

    await h.controller.retry();
    expect(h.controller.getSnapshot().status).toBe("failed");
    expect(h.writes).toEqual([GOAL_TEXT]);

    await h.controller.retry();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "created", error: null });
    expect(h.goalArgs).toHaveLength(3);
    expect(h.box()).toBe("");
  });

  test("a goal that is created removes its goal text from the box, when the person has not changed it", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);
    await h.controller.start();
    expect(h.box()).toBe(GOAL_TEXT);

    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(true);
    await h.controller.start();

    expect(h.controller.getSnapshot().status).toBe("created");
    expect(h.box()).toBe("");
    expect(h.writes).toEqual([GOAL_TEXT, ""]);
  });

  test("a goal that is created leaves the box alone when the person typed in it since", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(false);
    await h.controller.start();
    h.typeIntoBox(`${GOAL_TEXT}\n\nmy own note`);

    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(true);
    await h.controller.start();

    expect(h.controller.getSnapshot().status).toBe("created");
    expect(h.box()).toBe(`${GOAL_TEXT}\n\nmy own note`);
  });
});

describe("guided goal controller: the confirmation and Try again", () => {
  test("a confirmation that cannot be shown keeps the goal text, creates nothing, and Try again asks the interview again", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(
      new AppFailure({ code: "unavailable", message: "Dialogs are offline.", retryable: true }),
    );

    await h.controller.start();

    expect(h.controller.getSnapshot()).toMatchObject({
      status: "failed",
      error: {
        message: "The goal interview could not finish. Your answers are still here.",
        retryable: true,
      },
    });
    expect(h.box()).toBe(GOAL_TEXT);
    expect(h.goalArgs).toEqual([]);

    // Try again does not create the goal: it opens the interview, and only a second confirmation can create it.
    h.reply(...interviewReplies("", "Ship the parser, reviewed again"));
    h.confirmReply(false);
    await h.controller.retry();

    expect(h.confirmations).toHaveLength(2);
    expect(h.goalArgs).toEqual([]);
    expect(h.controller.getSnapshot().status).toBe("cancelled");
    expect(h.box()).toBe("Ship the parser, reviewed again");
  });

  test("Try again after a failed create creates the confirmed goal without asking again", async () => {
    const h = makeHarness({
      creates: [new AppFailure({ code: "unavailable", message: "Dropped.", retryable: true })],
    });
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(true);

    await h.controller.start();
    await h.controller.retry();

    expect(h.confirmations).toHaveLength(1);
    expect(h.goalArgs).toEqual([
      { op: "create", objective: GOAL_TEXT },
      { op: "create", objective: GOAL_TEXT },
    ]);
    expect(h.controller.getSnapshot().status).toBe("created");
  });

  test("a goal that omp refuses shows omp's own reason", async () => {
    const h = makeHarness({
      creates: [
        new AppFailure({
          code: "omp_error",
          message: "Exit plan mode before starting a goal.",
          retryable: false,
        }),
      ],
    });
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(true);

    await h.controller.start();

    expect(h.controller.getSnapshot()).toMatchObject({
      status: "failed",
      error: { message: "Exit plan mode before starting a goal.", retryable: false },
    });
  });

  test("a goal that appears during the confirmation blocks the create, and its reason is shown", async () => {
    const h = makeHarness();
    h.reply(...interviewReplies("", GOAL_TEXT));
    h.confirmReply(() => {
      h.setState(stateOf("active", true));
      return true;
    });

    await h.controller.start();

    expect(h.goalArgs).toEqual([]);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "failed",
      error: { message: "A goal is already active. Drop it before creating another." },
    });
    expect(h.box()).toBe(GOAL_TEXT);
  });
});

describe("guided goal controller: the answers, dispose and start", () => {
  test("start again opens each question with the answer given earlier in this page session", async () => {
    const h = makeHarness();
    h.reply(answer(SIX[0]), answer(SIX[1]), answer(SIX[2]), answer(SIX[3]), closed(""));
    await h.controller.start();

    h.reply(closed(""));
    await h.controller.start();

    expect(h.requests[5]).toMatchObject({ kind: "editor", prefill: "Ship the parser" });
  });

  test("dispose during a question hands the answers so far to the box at once, and the open dialog's text replaces them", async () => {
    const h = makeHarness();
    h.reply(answer(SIX[0]), HOLD);
    const started = h.controller.start();
    await h.untilHeld();

    h.controller.dispose();

    expect(h.box()).toBe("What should omp get done?\nShip the parser");
    h.resolveHeld(closed("All tests pass, typed"));
    await started;
    expect(h.box()).toBe(
      "What should omp get done?\nShip the parser\n\nHow will you know it is done?\nAll tests pass, typed",
    );
    expect(h.writes).toHaveLength(2);
  });

  test("dispose during the confirmation writes the reviewed goal at once, and a later decline adds nothing", async () => {
    const h = makeHarness();
    h.reply(...SIX.map(answer), answer(""), answer(GOAL_TEXT));
    h.confirmReply("hold");
    const started = h.controller.start();
    await h.untilHeld();

    h.controller.dispose();

    expect(h.box()).toBe(GOAL_TEXT);
    h.resolveHeldConfirm(false);
    await started;
    expect(h.box()).toBe(GOAL_TEXT);
    expect(h.writes).toEqual([GOAL_TEXT]);
  });

  test("dispose aborts the open dialog, and nothing is published afterwards", async () => {
    const h = makeHarness();
    h.reply(HOLD);
    const started = h.controller.start();
    await h.untilHeld();
    const signal = h.optionsSeen[0]?.signal;

    h.controller.dispose();
    expect(signal?.aborted).toBe(true);
    h.resolveHeld(closed(""));
    await started;

    expect(h.controller.getSnapshot().status).toBe("interviewing");
  });

  test("a start while the interview is open does nothing", async () => {
    const h = makeHarness();
    h.reply(HOLD);
    const started = h.controller.start();
    await h.untilHeld();

    await h.controller.start();
    expect(h.requests).toHaveLength(1);

    h.resolveHeld(closed(""));
    await started;
  });
});

describe("guided goal controller: the goal omp already has", () => {
  test("an enabled goal blocks the start, and the reason is shown", async () => {
    const h = makeHarness({ state: stateOf("active", true) });

    await h.controller.start();

    expect(h.requests).toEqual([]);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "idle",
      createReason: "A goal is already active. Drop it before creating another.",
    });
  });

  test("a paused goal blocks the start with omp's own paused message", async () => {
    const h = makeHarness({ state: stateOf("paused", false) });

    await h.controller.start();

    expect(h.requests).toEqual([]);
    expect(h.controller.getSnapshot().createReason).toBe(
      "Resume or drop the paused goal before creating another.",
    );
  });

  test("a goal that is complete or dropped does not block a new one", () => {
    const complete = makeHarness({ state: stateOf("complete", false) });
    const dropped = makeHarness({ state: stateOf("dropped", false) });

    expect(complete.controller.getSnapshot().createReason).toBeNull();
    expect(dropped.controller.getSnapshot().createReason).toBeNull();
  });

  test("an unavailable goal command blocks the start, and the reason is shown", async () => {
    const h = makeHarness({ unavailable: true });

    await h.controller.start();

    expect(h.requests).toEqual([]);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "idle",
      createReason: "Goals cannot be created in this connection right now.",
    });
  });

  test("a goal created or dropped elsewhere updates the blocked state at once", () => {
    const h = makeHarness();
    expect(h.controller.getSnapshot().createReason).toBeNull();

    h.setState(stateOf("active", true));
    expect(h.controller.getSnapshot().createReason).toBe(
      "A goal is already active. Drop it before creating another.",
    );

    h.setState(null);
    expect(h.controller.getSnapshot().createReason).toBeNull();
  });
});
