/**
 * Plan mode on the chat host (SDK plan H5.2g3, the host half of #768), as omp's terminal does it with `/plan`, without
 * its switch to the plan model, which omp's ACP host leaves out too (18.12.6 `modes/interactive-mode.ts:4976-5235,
 * 5893-6161`). Carried from the frozen H3.2 branch's `app-commands.ts`, with omp's helpers imported directly.
 */
// omp's own prompt for the run on an approved plan. Its package does not export prompt files, so the path goes
// through the package's folder; Bun builds the text into the program.

import { humanizePlanTitle } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { autosaveApprovedPlan } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave";
import { readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import {
  cfgPlanDefaultOnStartup,
  cfgPlanEnabled,
} from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { isMCPToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { writeDeviceDispatch } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { PROPOSE_DEVICE_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ApprovePlanResult, PlanFile, PlanModeStatus } from "@omp-app/contracts/chat-host";
import approvedPlanPrompt from "../../node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-approved.md" with {
  type: "text",
};
import { HostMethodError } from "./method-error";

/** The plan file plan mode writes unless the session already approved one (`interactive-mode.ts:4693-4695`). */
const DEFAULT_PLAN_FILE = "local://PLAN.md";

export class PlanMode {
  readonly #session: AgentSession;
  /** Tells the app what omp's terminal shows as a warning. */
  readonly #warn: (message: string) => void;
  /** Tells every page the status after plan mode turned on or off (#2812): omp's own state sends no event. */
  readonly #changed: (status: PlanModeStatus) => void;
  /** Stops the running turn as the user's Stop does. */
  readonly #interrupt: () => Promise<void>;
  /**
   * The tools before plan mode turned on, for the way back (the terminal's `#planModePreviousToolPresentation`):
   * `registered` is every tool the session had then, so one registered during plan mode stays on afterwards (omp 18.18).
   */
  #toolsBefore:
    | { readonly enabled: string[]; readonly mounted: string[]; readonly registered: string[] }
    | undefined;
  /** Plan mode was on before in this session: omp tells the model it is coming back to a plan (`reentry`). */
  #plannedBefore = false;

  constructor(
    session: AgentSession,
    warn: (message: string) => void,
    changed: (status: PlanModeStatus) => void,
    interrupt: () => Promise<void>,
  ) {
    this.#session = session;
    this.#warn = warn;
    this.#changed = changed;
    this.#interrupt = interrupt;
  }

  status(): PlanModeStatus {
    const state = this.#session.getPlanModeState();
    return {
      enabled: state?.enabled === true,
      available: cfgPlanEnabled.get(this.#session.settings),
      ...(state?.enabled ? { planFilePath: state.planFilePath } : {}),
    };
  }

  /**
   * omp's `/plan` and Alt+Shift+P (`handlePlanModeCommand`, `interactive-mode.ts:6093-6161`), refused while a goal is
   * active. While omp works, as there: turned on, plan mode steers the running turn into it (`#enter`); turned off, it
   * stops the turn first (`#exitPlanMode` with `interruptActiveTurn`, 5274-5295), since that turn plans with tools
   * plan mode is taking away and would only be told to go on planning.
   */
  async set(enabled: boolean): Promise<PlanModeStatus> {
    const session = this.#session;
    if (enabled && !session.getPlanModeState()?.enabled) {
      if (!cfgPlanEnabled.get(session.settings)) {
        throw new HostMethodError(
          "plan_disabled",
          "Plan mode is turned off in omp's settings (plan.enabled).",
        );
      }
      if (this.#goalHolds()) {
        throw new HostMethodError(
          "goal_active",
          "This chat has a goal. Stop the goal before turning plan mode on.",
        );
      }
    }
    if (enabled) await this.#enter();
    else if (session.getPlanModeState()?.enabled && session.isStreaming) {
      // Inside omp's mode-exit teardown, so a message queued during the stopped turn starts once the tools are back.
      await session.runModeExitTeardown(async () => {
        await this.#interrupt();
        await this.#leave({ persist: true });
      });
    } else await this.#leave({ persist: true });
    return this.status();
  }

  /**
   * The model proposed its plan (a `write` to `xd://propose`). As at omp's review (`event-controller.ts:2229-2268`,
   * `handlePlanApproval`), the turn stops at once, with no "aborted" line, so the model does not go on under the
   * review (omp's plan prompt would have it plan on) and the plan can be approved.
   */
  observe(event: AgentSessionEvent): void {
    if (event.type !== "tool_execution_end" || event.isError) return;
    const dispatch = writeDeviceDispatch(event.toolName, event.result);
    if (dispatch?.tool !== PROPOSE_DEVICE_NAME || dispatch.mode !== "execute") return;
    if (!this.#session.getPlanModeState()?.enabled) return;
    void this.#stopSilently().catch((error: unknown) =>
      this.#warn(
        `Could not stop the turn for the plan's review: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /** A plan file's text: the one named, else plan mode's, else the approved plan's, else `local://PLAN.md`. */
  async read(requested: string | undefined): Promise<PlanFile> {
    const planFilePath =
      requested ??
      this.#session.getPlanModeState()?.planFilePath ??
      (this.#session.getPlanReferencePath() || DEFAULT_PLAN_FILE);
    const content = await readPlanFile(planFilePath, this.#pathOptions());
    if (content === null)
      throw new HostMethodError("plan_missing", `There is no plan at ${planFilePath} yet.`);
    return { planFilePath, content };
  }

  /**
   * omp's "Approve and keep context" (`#approvePlan`, `interactive-mode.ts:5893-6083`). A turn still going stops first,
   * silently, as when omp's review opens. Answered once omp admitted the run on the plan; the run's events reach the
   * app like any turn's.
   */
  async approve(planFilePath: string, title: string): Promise<ApprovePlanResult> {
    const session = this.#session;
    if (!session.getPlanModeState()?.enabled) {
      throw new HostMethodError(
        "plan_mode_off",
        "Plan mode is off in this chat, so there is no plan to approve.",
      );
    }
    const planContent = await readPlanFile(planFilePath, this.#pathOptions());
    if (planContent === null)
      throw new HostMethodError("plan_missing", `There is no plan at ${planFilePath}.`);
    if (session.isBusyForSnapshot) await this.#stopSilently();
    await this.#leave({ persist: true, forceRead: true });
    session.setPlanReferencePath(planFilePath);
    let autosavedPath: string | undefined;
    try {
      autosavedPath =
        (await autosaveApprovedPlan({
          settings: session.settings,
          cwd: session.sessionManager.getCwd(),
          title,
          planContent,
        })) ?? undefined;
    } catch (error) {
      // As omp's terminal (`interactive-mode.ts:5990-5999`): a warning, and the plan runs anyway.
      const detail = (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n]+/g, " ")
        .trim();
      this.#warn(`Failed to autosave plan: ${detail}`);
    }
    const name = humanizePlanTitle(title);
    if (name && !session.sessionManager.getSessionName())
      await session.sessionManager.setSessionName(name, "auto");
    session.markPlanReferenceSent();
    const admitted = Promise.withResolvers<void>();
    const run = session.prompt(
      prompt.render(approvedPlanPrompt, { planFilePath, planContent, contextPreserved: true }),
      { synthetic: true, onPromptAdmitted: () => admitted.resolve() },
    );
    // A failure before omp admits the run is this request's error; after that it is the run's, in its events. The race
    // keeps its handler on `run`, so a later rejection is not unhandled.
    await Promise.race([admitted.promise, run]);
    return { planFilePath, ...(autosavedPath ? { autosavedPath } : {}) };
  }

  /**
   * The terminal's `#reconcileModeFromSession` for plan mode, which omp's session runs after `/new`, a switch and a
   * branch (`setSessionSwitchReconciler`, `agent-session.ts:2975-2994`), and the terminal at launch: plan mode ends with
   * the session it belonged to, and comes back when the session now open was left in it.
   */
  async reconcile(): Promise<void> {
    const session = this.#session;
    await this.#leave({ persist: false });
    this.#plannedBefore = false;
    const context = session.sessionManager.buildSessionContext();
    const planned = context.mode === "plan" || context.mode === "plan_paused";
    if (!cfgPlanEnabled.get(session.settings)) {
      // As omp: a turned-off setting clears the session's stale plan mode for good.
      if (planned) session.sessionManager.appendModeChange("none");
      return;
    }
    if (context.mode === "plan") {
      const planFilePath = context.modeData?.planFilePath;
      await this.#enter(typeof planFilePath === "string" ? planFilePath : undefined);
    } else if (context.mode === "plan_paused") {
      this.#plannedBefore = true;
    }
  }

  /**
   * omp's `plan.defaultOnStartup` ("Start in Plan Mode"), as the terminal applies it at launch and after a `/new` the
   * user asked for (`#applyPlanModeDefault`, `interactive-mode.ts:633-645, 5142-5146`): a session with no conversation
   * and no mode of its own opens in plan mode.
   */
  async applyStartupDefault(): Promise<void> {
    const { sessionManager, settings } = this.#session;
    if (sessionManager.buildSessionContext().messages.length > 0) return;
    if (sessionManager.getEntries().some((entry) => entry.type === "mode_change")) return;
    if (!cfgPlanDefaultOnStartup.get(settings) || !cfgPlanEnabled.get(settings)) return;
    if (this.#goalHolds()) return;
    await this.#enter();
  }

  async #enter(requestedPlanFile?: string): Promise<void> {
    const session = this.#session;
    const previousState = session.getPlanModeState();
    if (previousState?.enabled) return;
    const previousTools = session.getEnabledToolNames();
    const previousMounted = session.getMountedXdevToolNames();
    const previousRegistered = session.getAllToolNames();
    // The plan is drafted with `write` and submitted by a `write` to `xd://propose`, so the built-in `write` stays; an
    // extension's `write` cannot submit a plan and would break plan mode's read-only guard (`interactive-mode.ts:5170-5192`).
    const planTools = [
      ...new Set([
        ...previousTools.filter((name) => name !== "write"),
        ...(session.hasBuiltInTool("write") ? ["write"] : []),
      ]),
    ];
    const planFilePath = requestedPlanFile ?? (session.getPlanReferencePath() || DEFAULT_PLAN_FILE);
    // The state goes first: it keeps `write` usable as the plan's transport while the tools change.
    session.setPlanModeState({
      enabled: true,
      planFilePath,
      workflow: "parallel",
      reentry: this.#plannedBefore,
    });
    try {
      await session.setActiveToolsByName(planTools);
    } catch (error) {
      session.setPlanModeState(previousState);
      throw error;
    }
    this.#toolsBefore = {
      enabled: previousTools.filter((name) => !isMCPToolName(name)),
      mounted: previousMounted.filter((name) => !isMCPToolName(name)),
      registered: previousRegistered,
    };
    session.setPlanProposalHandler((planTitle) => session.preparePlanForReview(planTitle));
    // A run already going learns about plan mode at once, as in the terminal.
    if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
    this.#plannedBefore = true;
    session.sessionManager.appendModeChange("plan", { planFilePath });
    this.#changed(this.status());
  }

  /**
   * `persist` writes the `none` entry; a reconcile leaves the previous session's mode in its own file. `forceRead`
   * keeps `read` on after an approval, so the plan file stays readable (`interactive-mode.ts:5972-5977`).
   */
  async #leave(options: {
    readonly persist: boolean;
    readonly forceRead?: boolean;
  }): Promise<void> {
    const session = this.#session;
    const state = session.getPlanModeState();
    if (!state?.enabled) return;
    const before = this.#toolsBefore;
    session.setPlanModeState(undefined);
    try {
      if (before) {
        const enabled =
          options.forceRead && !before.enabled.includes("read")
            ? [...before.enabled, "read"]
            : before.enabled;
        await session.restoreNonMCPToolPresentation(enabled, before.mounted, before.registered);
      }
    } catch (error) {
      session.setPlanModeState(state);
      throw error;
    }
    this.#toolsBefore = undefined;
    session.setPlanProposalHandler(null);
    if (options.persist) session.sessionManager.appendModeChange("none");
    this.#changed(this.status());
  }

  /** A goal is active or paused: the terminal refuses plan mode for both ("Exit goal mode first."). */
  #goalHolds(): boolean {
    const goal = this.#session.getGoalModeState();
    return goal?.enabled === true || goal?.goal.status === "paused";
  }

  #pathOptions(): Parameters<typeof readPlanFile>[1] {
    const { sessionManager } = this.#session;
    return {
      localProtocolOptions: {
        getArtifactsDir: () => sessionManager.getArtifactsDir(),
        getSessionId: () => sessionManager.getSessionId(),
      },
      cwd: sessionManager.getCwd(),
    };
  }

  /**
   * omp's stop for a plan's review (`#abortPlanApprovalTurnSilently`, `interactive-mode.ts:6084-6091`): the stopped
   * reply is marked a silent abort, which is no failure to show.
   */
  async #stopSilently(): Promise<void> {
    this.#session.markPlanInternalAbortPending();
    try {
      await this.#session.abort();
    } finally {
      this.#session.clearPlanInternalAbortPending();
    }
  }
}
