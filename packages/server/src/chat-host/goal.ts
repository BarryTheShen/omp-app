/**
 * Goal mode on the chat host (SDK plan H5.2g2), as omp's RPC goal controller drives it (18.12.6
 * `modes/rpc/rpc-goal.ts`). The goal's lifecycle, accounting and persistence are omp's `GoalRuntime`; this adds what a
 * host owns:
 * - the goal tool in the active tool set while a goal runs, and the earlier set back after it;
 * - completion and drop;
 * - the goal across session changes and tree navigation;
 * - the continuation driver: after a yield, a continuation turn while the goal is active and the last one made progress.
 * The app's chats ran as omp's RPC host, so continuation follows the `rpc` entry of omp's `goal.continuationModes`
 * setting, as it did there.
 */
import { cfgGoalContinuationModes, cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import {
  type GoalModeState,
  goalContinuationActivity,
  goalFromModeData,
} from "@oh-my-pi/pi-coding-agent/goals/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { nextActionableTask } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { GoalAnswer, GoalParams } from "@omp-app/contracts/chat-host";

/** The `goal.continuationModes` entry that turns automatic continuation on for the app's chats (omp's RPC hosts'). */
const CONTINUATION_MODE = "rpc";

export type GoalSession = Pick<
  AgentSession,
  | "settings"
  | "sessionManager"
  | "goalRuntime"
  | "getGoalModeState"
  | "setGoalModeState"
  | "getPlanModeState"
  | "getEnabledToolNames"
  | "setActiveToolsByName"
  | "sendGoalModeContext"
  | "getTodoPhases"
  | "promptCustomMessage"
  | "waitForIdle"
  | "isStreaming"
  | "isDisposed"
  | "isSessionTransitioning"
  | "hasAdmittedSubmission"
  | "queuedMessageCount"
>;

export class GoalController {
  readonly #session: GoalSession;
  readonly #log: (line: string) => void;
  /** Called when a decided continuation is abandoned, so the settle report checks again. */
  readonly #onContinuationDropped: () => void;
  /** The active tool set before the goal added `goal`; restored when the goal ends. */
  #previousTools: string[] | undefined;
  /** Continuation turns submitted whose terminal `agent_end` has not arrived. */
  #pendingContinuationTurns = 0;
  #previousContinuationActivity: string | undefined;
  /** A continuation turn made no new progress: wait for the host before continuing. */
  #suppressContinuation = false;
  /** Set by a host abort; only host action (a prompt, `goal create` or `resume`) clears it. */
  #hostStopped = false;
  /** A continuation was decided and waits for the session to go idle. */
  #continuationScheduled = false;
  /** Bumped by a host abort or session change: a continuation decided before it is void. */
  #continuationGeneration = 0;
  /** Tool-set restores triggered by session events; commands and reads wait for them. */
  #exitTask: Promise<void> = Promise.resolve();
  /** Session changes in progress: goal turns are held until they end. */
  #sessionChanges = 0;
  /** The transcript id when the outermost change began. */
  #sessionBeforeChange: string | undefined;
  /** A goal turn waited or became due during the change: busy until it ends. */
  #heldDuringChange = false;
  #reconcileTask: Promise<void> = Promise.resolve();
  #reconcilesPending = 0;
  /** The change began while a reconcile was queued or running: reconcile again after it, whatever the ids say. */
  #changeOverlappedReconcile = false;

  constructor(
    session: GoalSession,
    log: (line: string) => void,
    onContinuationDropped: () => void,
  ) {
    this.#session = session;
    this.#log = log;
    this.#onContinuationDropped = onContinuationDropped;
  }

  /** A continuation is decided but not yet admitted: the session is not settled meanwhile. */
  get continuationPending(): boolean {
    // A change holding a goal turn may resume it when cancelled.
    return this.#continuationScheduled || (this.#sessionChanges > 0 && this.#heldDuringChange);
  }

  /** The host stopped the session: no continuation until it acts again. Called before the abort starts. */
  stopForHostAbort(): void {
    this.#hostStopped = true;
    this.#suppressContinuation = true;
    this.#continuationScheduled = false;
    this.#continuationGeneration++;
  }

  get #answer(): GoalAnswer {
    const state = this.#session.getGoalModeState();
    return { goal: state?.goal ?? null, state: state ?? null };
  }

  /** Resolves once queued goal exits and reconciles have run, so a command never acts on the previous session's goal. */
  async settled(): Promise<void> {
    for (let tail = this.#reconcileTask; ; tail = this.#reconcileTask) {
      await this.#exitTask;
      await tail;
      if (tail === this.#reconcileTask) return;
    }
  }

  /** Before any session change or tree navigation: a waiting exit lands first, and goal turns are held. */
  async beginSessionChange(): Promise<void> {
    if (this.#sessionChanges++ === 0) {
      // The transcript's id: a pinned provider session id does not change when the transcript does.
      this.#sessionBeforeChange = this.#session.sessionManager.getSessionId();
      this.#heldDuringChange = this.#continuationScheduled || this.#continuationWanted();
    }
    if (this.#reconcilesPending > 0) this.#changeOverlappedReconcile = true;
    this.#continuationScheduled = false;
    this.#continuationGeneration++;
    await this.#exitTask;
  }

  /**
   * After the change resolved, was cancelled or threw. Only a change that switched the transcript adopts its goal, and
   * an active goal stays active across it; a cancelled or same-session change resumes continuation. `detachedRun`: the
   * change stopped the running agent, so its continuation turn never ends with an `agent_end`.
   */
  async endSessionChange(options?: { readonly detachedRun?: boolean }): Promise<void> {
    if (options?.detachedRun) {
      this.#pendingContinuationTurns = 0;
      this.#previousContinuationActivity = undefined;
    }
    if (--this.#sessionChanges > 0) return;
    const switched =
      this.#changeOverlappedReconcile ||
      this.#session.sessionManager.getSessionId() !== this.#sessionBeforeChange;
    this.#changeOverlappedReconcile = false;
    this.#sessionBeforeChange = undefined;
    this.#heldDuringChange = false;
    try {
      if (switched && this.#reconcilesPending > 0) {
        // A reconcile runs, maybe the one whose extension notice started this change: queue behind it without
        // waiting, or the two would wait on each other.
        void this.reconcile({ preserveActiveGoal: true })
          .then(() => this.#scheduleContinuation())
          .catch((error: unknown) => this.#report(error))
          .finally(() => this.#onContinuationDropped());
        return;
      }
      if (switched) await this.reconcile({ preserveActiveGoal: true });
      this.#scheduleContinuation();
    } catch (error) {
      this.#report(error);
    }
    this.#onContinuationDropped();
  }

  async handle(params: GoalParams): Promise<GoalAnswer> {
    await this.settled();
    switch (params.op) {
      case "get":
        return this.#answer;
      case "create":
        return await this.#create(params);
      case "resume":
        return await this.#resume();
      case "pause":
        await this.#session.goalRuntime.pauseGoal();
        await this.#exit();
        return this.#answer;
      case "drop":
        // The runtime's `goal_updated(dropped)` queues the exit.
        await this.#session.goalRuntime.dropGoal();
        await this.#exitTask;
        return this.#answer;
    }
  }

  /**
   * Leaves the previous session's goal and restores one journaled in the current session (at start, and after a
   * change that switched it), as omp's terminal reattaches. `preserveActiveGoal` keeps an active goal active (a change
   * within the process); without it an active goal is paused (start).
   */
  async reconcile(options?: { readonly preserveActiveGoal?: boolean }): Promise<void> {
    this.#reconcilesPending++;
    const run = this.#reconcileTask.then(() => this.#reconcileOnce(options));
    this.#reconcileTask = run
      .catch((error: unknown) => this.#report(error))
      .finally(() => {
        this.#reconcilesPending--;
      });
    await run;
  }

  /** Session events; before the prompt results and the settle report see them, so a continuation counts as pending. */
  observe(event: AgentSessionEvent): void {
    if (
      event.type === "message_start" &&
      event.message.role === "user" &&
      !event.message.synthetic
    ) {
      // A host prompt re-arms continuation after a stop without progress.
      this.#resetContinuation();
      return;
    }
    if (event.type === "goal_updated") {
      const status = event.state?.goal.status;
      if (status === "dropped") {
        this.#queueExit(() => this.#exit());
      } else if (event.state?.enabled && this.#previousTools === undefined) {
        // Created by the agent's `goal` tool, not by the host.
        this.#previousTools = this.#session.getEnabledToolNames();
      }
      return;
    }
    if (event.type !== "agent_end" || event.isTerminal === false) return;
    if (this.#pendingContinuationTurns > 0) {
      this.#pendingContinuationTurns--;
      const activity = goalContinuationActivity(event.messages);
      this.#suppressContinuation =
        activity.length === 0 || activity === this.#previousContinuationActivity;
      this.#previousContinuationActivity = activity;
    } else {
      // A turn that was not a continuation (a prompt, a job's wake, an extension's turn) re-arms; a host abort stays.
      this.#suppressContinuation = false;
      this.#previousContinuationActivity = undefined;
    }
    if (this.#session.getGoalModeState()?.mode === "exiting") {
      // Journaled now, while the transcript is the one that completed the goal; only the tool restore is queued.
      this.#journalCompletion();
      this.#queueExit(() => this.#exit());
      return;
    }
    this.#scheduleContinuation();
  }

  #queueExit(exit: () => Promise<void>): void {
    this.#exitTask = this.#exitTask.then(exit).catch((error: unknown) => this.#report(error));
  }

  #assertCanEnter(): void {
    if (!cfgGoalEnabled.get(this.#session.settings))
      throw new Error("Goal mode is disabled (goal.enabled).");
    if (this.#session.getPlanModeState()?.enabled)
      throw new Error("Exit plan mode before starting a goal.");
  }

  async #create(params: GoalParams): Promise<GoalAnswer> {
    this.#assertCanEnter();
    const objective = params.objective?.trim();
    if (!objective) throw new Error("objective is required when op=create");
    const tokenBudget = params.token_budget;
    const current = this.#session.getGoalModeState();
    if (current?.enabled)
      throw new Error("A goal is already active. Drop it before creating another.");
    if (current?.goal.status === "paused")
      throw new Error("Resume or drop the paused goal before creating another.");
    await this.#enter(() => this.#session.goalRuntime.createGoal({ objective, tokenBudget }));
    return this.#answer;
  }

  async #resume(): Promise<GoalAnswer> {
    this.#assertCanEnter();
    const current = this.#session.getGoalModeState();
    if (current?.enabled) return this.#answer;
    if (current?.goal.status !== "paused") throw new Error("No paused goal to resume.");
    await this.#enter(() => this.#session.goalRuntime.resumeGoal());
    return this.#answer;
  }

  async #enter(start: () => Promise<GoalModeState>): Promise<void> {
    // The tool set before the goal, kept once; a `goal` tool the host enabled before stays afterwards.
    const previousTools = this.#previousTools ?? this.#session.getEnabledToolNames();
    const state = await start();
    this.#previousTools = previousTools;
    await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
    this.#session.setGoalModeState(state);
    this.#resetContinuation();
    if (this.#session.isStreaming) {
      await this.#session.sendGoalModeContext({ deliverAs: "steer" });
      return;
    }
    this.#scheduleContinuation();
  }

  /** Restores the tool set from before the goal. */
  async #exit(): Promise<void> {
    const previousTools = this.#previousTools;
    this.#previousTools = undefined;
    this.#resetContinuation();
    if (previousTools) await this.#session.setActiveToolsByName(previousTools);
  }

  /** The completion records in the current transcript, and no goal state. */
  #journalCompletion(): void {
    const state = this.#session.getGoalModeState();
    this.#session.setGoalModeState(undefined);
    this.#session.sessionManager.appendModeChange("none");
    this.#session.sessionManager.appendCustomEntry("goal-completed", {
      objective: state?.goal.objective,
      tokensUsed: state?.goal.tokensUsed,
      tokenBudget: state?.goal.tokenBudget,
      timeUsedSeconds: state?.goal.timeUsedSeconds,
    });
  }

  #resetContinuation(): void {
    this.#pendingContinuationTurns = 0;
    this.#previousContinuationActivity = undefined;
    this.#suppressContinuation = false;
    this.#hostStopped = false;
  }

  async #reconcileOnce(
    options: { readonly preserveActiveGoal?: boolean } | undefined,
  ): Promise<void> {
    // The goal state and the goal tool belong to the session that set them; the session keeps both across a switch.
    this.#continuationScheduled = false;
    this.#continuationGeneration++;
    await this.#exitTask;
    await this.#exit();
    this.#session.setGoalModeState(undefined);
    const context = this.#session.sessionManager.buildSessionContext();
    const runtime = this.#session.goalRuntime;
    if (context.mode !== "goal" && context.mode !== "goal_paused") {
      runtime.clearAccounting();
      return;
    }
    const goal = cfgGoalEnabled.get(this.#session.settings)
      ? goalFromModeData(context.modeData)
      : undefined;
    if (!goal) {
      runtime.clearAccounting();
      this.#session.sessionManager.appendModeChange("none");
      return;
    }
    this.#session.setGoalModeState({ enabled: context.mode === "goal", mode: "active", goal });
    const restored = await runtime.onThreadResumed({
      preserveActiveGoal: options?.preserveActiveGoal,
    });
    if (!restored?.goal) return;
    const previousTools = this.#session.getEnabledToolNames();
    this.#previousTools = previousTools;
    await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
  }

  /** Whether continuation is wanted at all, whether or not the session is busy right now. */
  #continuationWanted(): boolean {
    const session = this.#session;
    if (!cfgGoalContinuationModes.get(session.settings).includes(CONTINUATION_MODE)) return false;
    if (this.#hostStopped || this.#suppressContinuation || session.isDisposed) return false;
    if (session.getPlanModeState()?.enabled) return false;
    const state = session.getGoalModeState();
    if (!state?.enabled || state.goal.status !== "active") return false;
    // Every task left is blocked: nothing a continuation could do.
    const phases = session.getTodoPhases();
    return !(
      !nextActionableTask(phases) &&
      phases.some((phase) => phase.tasks.some((task) => task.status === "blocked"))
    );
  }

  /**
   * Decides at a yield to continue the goal, and admits the continuation once the yielding run has unwound. At
   * admission every gate is read again: an abort, a dispose, a pause, plan mode or another turn meanwhile drops it.
   */
  #scheduleContinuation(): void {
    if (this.#sessionChanges > 0) {
      // Held until the change ends; a same-session change resumes it.
      if (this.#continuationWanted()) this.#heldDuringChange = true;
      return;
    }
    if (this.#continuationScheduled || !this.#continuationWanted()) return;
    this.#continuationScheduled = true;
    const generation = this.#continuationGeneration;
    void (async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
      await this.#session.waitForIdle();
      if (!this.#continuationScheduled || generation !== this.#continuationGeneration) {
        this.#onContinuationDropped();
        return;
      }
      this.#continuationScheduled = false;
      const session = this.#session;
      const idle =
        !session.isStreaming &&
        !session.hasAdmittedSubmission &&
        session.queuedMessageCount === 0 &&
        !session.isSessionTransitioning;
      const prompt =
        idle && this.#continuationWanted()
          ? session.goalRuntime.buildContinuationPrompt()
          : undefined;
      if (!prompt) {
        this.#onContinuationDropped();
        return;
      }
      this.#pendingContinuationTurns++;
      const unclaim = (): void => {
        this.#pendingContinuationTurns = Math.max(0, this.#pendingContinuationTurns - 1);
        // No run follows, so nothing else ends this stretch of activity.
        this.#onContinuationDropped();
      };
      // Admitted synchronously, so every settle report sees it from here on; one refused before its run starts must
      // neither stay counted nor hold back the settle report.
      session
        .promptCustomMessage({ customType: "goal-continuation", content: prompt, display: false })
        .then(
          (dispatched) => {
            if (!dispatched) unclaim();
          },
          (error: unknown) => {
            unclaim();
            this.#report(error);
          },
        );
    })().catch((error: unknown) => {
      this.#continuationScheduled = false;
      this.#onContinuationDropped();
      this.#report(error);
    });
  }

  #report(error: unknown): void {
    this.#log(
      `chat host: goal mode failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
