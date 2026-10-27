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
import { isMCPToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
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
  /** The tools before plan mode turned on, for the way back (the terminal's `#planModePreviousToolPresentation`). */
  #toolsBefore: { readonly enabled: string[]; readonly mounted: string[] } | undefined;
  /** Plan mode was on before in this session: omp tells the model it is coming back to a plan (`reentry`). */
  #plannedBefore = false;

  constructor(session: AgentSession) {
    this.#session = session;
  }

  status(): PlanModeStatus {
    const state = this.#session.getPlanModeState();
    return {
      enabled: state?.enabled === true,
      available: cfgPlanEnabled.get(this.#session.settings),
      ...(state?.enabled ? { planFilePath: state.planFilePath } : {}),
    };
  }

  /** omp's `/plan`. Refused while work runs (the terminal steers or aborts instead), and while a goal is active. */
  async set(enabled: boolean): Promise<PlanModeStatus> {
    this.#refuseWhileBusy("Switch plan mode");
    if (enabled && !this.#session.getPlanModeState()?.enabled) {
      if (!cfgPlanEnabled.get(this.#session.settings)) {
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
    else await this.#leave({ persist: true });
    return this.status();
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
   * omp's "Approve and keep context" (`#approvePlan`, `interactive-mode.ts:5893-6083`). Answered once omp admitted the
   * run on the plan; the run's events reach the app like any turn's.
   */
  async approve(planFilePath: string, title: string): Promise<ApprovePlanResult> {
    const session = this.#session;
    this.#refuseWhileBusy("Approve the plan");
    if (!session.getPlanModeState()?.enabled) {
      throw new HostMethodError(
        "plan_mode_off",
        "Plan mode is off in this chat, so there is no plan to approve.",
      );
    }
    const planContent = await readPlanFile(planFilePath, this.#pathOptions());
    if (planContent === null)
      throw new HostMethodError("plan_missing", `There is no plan at ${planFilePath}.`);
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
    } catch {
      // omp's terminal only warns when the copy fails, and runs the plan anyway.
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
    };
    session.setPlanProposalHandler((planTitle) => session.preparePlanForReview(planTitle));
    // A run already going learns about plan mode at once, as in the terminal.
    if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
    this.#plannedBefore = true;
    session.sessionManager.appendModeChange("plan", { planFilePath });
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
        await session.restoreNonMCPToolPresentation(enabled, before.mounted);
      }
    } catch (error) {
      session.setPlanModeState(state);
      throw error;
    }
    this.#toolsBefore = undefined;
    session.setPlanProposalHandler(null);
    if (options.persist) session.sessionManager.appendModeChange("none");
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

  #refuseWhileBusy(action: string): void {
    if (this.#session.isBusyForSnapshot) {
      throw new HostMethodError(
        "session_busy",
        `omp is still working in this chat. ${action} once it has finished.`,
      );
    }
  }
}
