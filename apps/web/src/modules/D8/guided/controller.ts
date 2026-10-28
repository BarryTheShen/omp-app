import type { AppError, CapabilityKey, CapabilityMap, ThreadId } from "@omp-app/contracts";
import { AppFailure, UiRequestId } from "@omp-app/contracts";
import type {
  ConfirmDialogRequest,
  EditorDialogRequest,
  InputDialogRequest,
} from "../../U4/contract";
import type { DialogHost, FocusRestoreHandle } from "../../U4/contract/dialog-host";
import type { AutonomyPort, GoalModeState, GoalArgs } from "../contract";
import { type GuidedComposerDraft, reviewedGoalText } from "./composer";
import { type KeptBlock, placeBlock, removeBlock } from "./composer-block";
import {
  BUDGET_QUESTION,
  buildGoalObjective,
  EMPTY_GUIDED_ANSWERS,
  GUIDED_QUESTIONS,
  type GuidedAnswers,
  type GuidedQuestion,
  interviewDraftText,
  type PendingAnswer,
  parseTokenBudget,
} from "./interview";

const GOAL_CAPABILITY: CapabilityKey = "omp.cmd.goal";
const REVIEW_TITLE = "Review your goal. Edit it if you need to, then save.";
const REVIEW_EMPTY_TITLE = "The goal cannot be empty. Edit it, then save.";
const CREATED_NOTICE = "Goal created. omp works on it once you send a message.";

/**
 * `idle`: nothing started. `interviewing`: the U4 dialogs are open. `creating`: the typed goal create is running.
 * `created`: omp accepted the goal. `cancelled`: the person stopped before a goal was created. `failed`: the create was
 * refused or failed, or the interview could not finish.
 */
export type GuidedGoalStatus =
  | "idle"
  | "interviewing"
  | "creating"
  | "created"
  | "cancelled"
  | "failed";

export interface GuidedGoalSnapshot {
  readonly status: GuidedGoalStatus;
  /** A plain-English line for the person, or `null`. */
  readonly notice: string | null;
  /** omp's own reason, or the app's, for the last failure. */
  readonly error: AppError | null;
  /** Why a goal cannot be created right now, or `null` when it can. */
  readonly createReason: string | null;
}

/** The session's goal-mode state, read now, and told when it changes (`goalSourceOf`). */
export interface GuidedGoalSource {
  readonly getSnapshot: () => GoalModeState | null;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface GuidedGoalControllerOptions {
  readonly threadId: ThreadId;
  readonly autonomy: AutonomyPort;
  readonly dialogs: Pick<DialogHost, "open" | "confirm">;
  readonly capabilities: () => CapabilityMap | undefined;
  readonly goal: GuidedGoalSource;
  readonly restoreFocus?: FocusRestoreHandle;
  /** The chat's composer draft: the text the person has not sent is kept here. */
  readonly composer: GuidedComposerDraft;
}

interface ReviewedGoal {
  readonly objective: string;
  readonly tokenBudget: number | undefined;
}

/** Where the text went when the interview stopped before a goal was created. */
type KeptReport = "nothing" | "answers" | "goal" | "failed";

/** The value the person gave, or the reason the interview stopped, with its text kept in the message box. */
type Asked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kept: KeptReport };

type Interview =
  | { readonly kind: "reviewed"; readonly review: ReviewedGoal }
  | { readonly kind: "stopped"; readonly kept: KeptReport };

const CANCELLED_NOTICE: Readonly<Record<KeptReport, string>> = {
  nothing: "Interview cancelled. No goal was created.",
  answers: "Interview cancelled. No goal was created. Your answers are in the message box.",
  goal: "Interview cancelled. No goal was created. The goal text is in the message box.",
  failed:
    "Interview cancelled. No goal was created. Your text could not be put in the message box.",
};

function requestId(name: string): UiRequestId {
  return UiRequestId.parse(`app-d8-guided-${name}-${crypto.randomUUID()}`);
}

function appError(cause: unknown, message: string): AppError {
  if (cause instanceof AppFailure) {
    // omp's own reason (for example "A goal is already active.") is shown as it is.
    const shown = cause.appError.code === "omp_error" ? cause.appError.message : message;
    return new AppFailure({
      code: cause.appError.code,
      message: shown,
      retryable: cause.appError.retryable,
      ...(cause.appError.capability === undefined ? {} : { capability: cause.appError.capability }),
    }).appError;
  }
  return new AppFailure({ code: "internal", message, retryable: true }).appError;
}

function unexpectedAnswer(kind: string): AppFailure {
  return new AppFailure({
    code: "invalid_args",
    message: `The ${kind} dialog returned an unexpected answer.`,
    retryable: false,
  });
}

function numberText(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/** The confirmation before the create: Confirm creates the goal; Deny and Cancel create nothing. */
function confirmRequest(review: ReviewedGoal): ConfirmDialogRequest {
  const budget =
    review.tokenBudget === undefined
      ? "There is no token budget."
      : `Token budget: ${numberText(review.tokenBudget)} tokens.`;
  return {
    kind: "confirm",
    id: requestId("confirm"),
    title: "Create this goal?",
    message: `${budget} Confirm creates the goal. Deny or Cancel creates nothing, and the goal text goes into the message box.`,
  };
}

/**
 * Runs the guided goal interview as U4 dialogs: one editor per question, an optional token budget, the goal for review,
 * a confirmation, then one typed `goal` create. Nothing reaches omp before the confirmation. The answers are kept in this
 * controller's memory for the page session. Whenever a dialog closes without an answer (Cancel, Escape, a press outside,
 * a chat switch, a host close), the text the person had goes into the chat's message box, after anything they typed
 * there. The controller keeps one block there and replaces it, so the text never stacks.
 */
export class GuidedGoalController {
  private readonly options: GuidedGoalControllerOptions;
  private readonly abortController = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeGoal: () => void;
  private status: GuidedGoalStatus = "idle";
  private notice: string | null = null;
  private error: AppError | null = null;
  private answers: GuidedAnswers = EMPTY_GUIDED_ANSWERS;
  /** The confirmed goal, kept for Try again until its create succeeds. Set only after the person confirms. */
  private review: ReviewedGoal | null = null;
  /** The goal waiting for the person's confirmation: a dispose hands its text to the message box at once. */
  private awaitingConfirmation: ReviewedGoal | null = null;
  /** The block the interview last put in the message box, so a later write replaces it instead of adding another. */
  private kept: KeptBlock | null = null;
  private disposed = false;
  private snapshot: GuidedGoalSnapshot;

  public constructor(options: GuidedGoalControllerOptions) {
    this.options = options;
    this.unsubscribeGoal = options.goal.subscribe(() => this.publish());
    this.snapshot = this.deriveSnapshot();
  }

  public getSnapshot(): GuidedGoalSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts the interview. The answers given earlier in this page session open each question again. */
  public async start(): Promise<void> {
    if (this.disposed || this.status === "interviewing" || this.status === "creating") return;
    const block = this.createBlock();
    if (block !== null) {
      this.notice = block;
      this.publish();
      return;
    }
    // A new interview forgets the reviewed goal of the last one; the answers stay, so the questions open with them.
    this.review = null;
    this.error = null;
    this.notice = null;
    this.setStatus("interviewing");
    try {
      const interview = await this.askEverything();
      if (this.disposed) return;
      if (interview.kind === "stopped") {
        this.notice = CANCELLED_NOTICE[interview.kept];
        this.setStatus("cancelled");
        return;
      }
      // Only a confirmed goal reaches this point, so Try again never creates one that was not confirmed.
      this.review = interview.review;
      await this.create(interview.review);
    } catch (cause) {
      if (this.disposed) return;
      this.error = appError(
        cause,
        "The goal interview could not finish. Your answers are still here.",
      );
      this.setStatus("failed");
    }
  }

  /** Tries the create again with the confirmed goal, or starts the interview again when no goal was confirmed. */
  public async retry(): Promise<void> {
    if (this.disposed || this.status !== "failed") return;
    if (this.review === null) {
      await this.start();
      return;
    }
    await this.create(this.review);
  }

  /**
   * Hands the text the person has to the message box, then stops. A goal being reviewed or confirmed, or a goal that was
   * confirmed and not yet created, is handed over as goal text; otherwise the answers so far are. A dialog that is still
   * open hands its own text back when it closes, and that text replaces this one.
   */
  public dispose(): void {
    if (this.disposed) return;
    const goal = this.awaitingConfirmation ?? this.review;
    const text = goal === null ? interviewDraftText(this.answers) : reviewedGoalText(goal);
    if (text !== "") void this.keepText(text);
    this.disposed = true;
    this.abortController.abort();
    this.listeners.clear();
    this.unsubscribeGoal();
  }

  /** Each question in order, the budget, the review and the confirmation. */
  private async askEverything(): Promise<Interview> {
    for (const question of GUIDED_QUESTIONS) {
      const asked = await this.askQuestion(question);
      if (!asked.ok) return { kind: "stopped", kept: asked.kept };
      this.answers = { ...this.answers, [question.id]: asked.value };
    }
    const budget = await this.askBudget();
    if (!budget.ok) return { kind: "stopped", kept: budget.kept };
    this.answers = { ...this.answers, budget: budget.value.text };
    const objective = await this.reviewObjective(budget.value.tokenBudget);
    if (!objective.ok) return { kind: "stopped", kept: objective.kept };
    const review: ReviewedGoal = {
      objective: objective.value,
      tokenBudget: budget.value.tokenBudget,
    };
    if (!(await this.confirmReview(review)))
      return { kind: "stopped", kept: await this.keepGoal(review) };
    return { kind: "reviewed", review };
  }

  /** The confirmation. A failure to show it keeps the goal text in the box, then reports the failure. */
  private async confirmReview(review: ReviewedGoal): Promise<boolean> {
    this.awaitingConfirmation = review;
    try {
      return await this.options.dialogs.confirm(confirmRequest(review), this.dialogOptions());
    } catch (cause) {
      await this.keepGoal(review);
      throw cause;
    } finally {
      this.awaitingConfirmation = null;
    }
  }

  private async askQuestion(question: GuidedQuestion): Promise<Asked<string>> {
    let title: string = question.question;
    let prefill = this.answers[question.id];
    for (;;) {
      const request: EditorDialogRequest = {
        kind: "editor",
        id: requestId(question.id),
        title,
        prefill,
      };
      const result = await this.options.dialogs.open(request, this.dialogOptions());
      if (result.outcome === "cancelled") {
        const kept = await this.keepInterview({ id: question.id, text: result.draft ?? "" });
        return { ok: false, kept };
      }
      if (result.response.kind !== "editor") throw unexpectedAnswer("question");
      const value = result.response.value.trim();
      if (value !== "") return { ok: true, value };
      title = `Answer this question before you continue: ${question.question}`;
      prefill = "";
    }
  }

  private async askBudget(): Promise<Asked<{ text: string; tokenBudget: number | undefined }>> {
    let title: string = BUDGET_QUESTION;
    for (;;) {
      const request: InputDialogRequest = {
        kind: "input",
        id: requestId("budget"),
        title,
        placeholder:
          this.answers.budget.trim() === "" ? "Whole number of tokens" : this.answers.budget,
        optional: true,
      };
      const result = await this.options.dialogs.open(request, this.dialogOptions());
      if (result.outcome === "cancelled") {
        const kept = await this.keepInterview({ id: "budget", text: result.draft ?? "" });
        return { ok: false, kept };
      }
      if (result.response.kind !== "input") throw unexpectedAnswer("budget");
      const parsed = parseTokenBudget(result.response.value);
      if (parsed.ok) {
        return {
          ok: true,
          value: { text: result.response.value, tokenBudget: parsed.tokenBudget },
        };
      }
      // An input dialog cannot show its text again, so the entry stays in the message box while the question reopens.
      await this.keepInterview({ id: "budget", text: result.response.value });
      title = parsed.message;
    }
  }

  private async reviewObjective(tokenBudget: number | undefined): Promise<Asked<string>> {
    let title: string = REVIEW_TITLE;
    let prefill = buildGoalObjective(this.answers);
    for (;;) {
      const request: EditorDialogRequest = {
        kind: "editor",
        id: requestId("review"),
        title,
        prefill,
      };
      const result = await this.options.dialogs.open(request, this.dialogOptions());
      if (result.outcome === "cancelled") {
        // The person's edits to the objective are the goal text; with none, the answers are what is kept.
        const edited = (result.draft ?? "").trim();
        const kept =
          edited === ""
            ? await this.keepInterview(null)
            : await this.keepGoal({ objective: edited, tokenBudget });
        return { ok: false, kept };
      }
      if (result.response.kind !== "editor") throw unexpectedAnswer("review");
      const value = result.response.value.trim();
      if (value !== "") return { ok: true, value };
      title = REVIEW_EMPTY_TITLE;
      prefill = "";
    }
  }

  /** Puts the answers so far, with the entry being typed, in the message box. `"nothing"` when there is no text. */
  private async keepInterview(pending: PendingAnswer | null): Promise<KeptReport> {
    const text = interviewDraftText(this.answers, pending ?? undefined);
    if (text === "") return "nothing";
    return (await this.keepText(text)) ? "answers" : "failed";
  }

  private async keepGoal(review: ReviewedGoal): Promise<KeptReport> {
    return (await this.keepText(reviewedGoalText(review))) ? "goal" : "failed";
  }

  /**
   * Puts `text` in the message box as the interview's block, replacing the block kept last. The write is started at
   * once, so a dispose can hand the text over before it stops. `false` when the box could not be written.
   */
  private async keepText(text: string): Promise<boolean> {
    const placed = placeBlock(this.options.composer.read(), text, this.kept);
    this.kept = placed.kept;
    if (!placed.write) return true;
    try {
      await this.options.composer.write(placed.value);
      return true;
    } catch {
      return false;
    }
  }

  /** Removes the kept block once its goal exists, but only while the box still holds exactly what was written. */
  private async removeKept(): Promise<void> {
    const kept = this.kept;
    this.kept = null;
    if (kept === null) return;
    const next = removeBlock(this.options.composer.read(), kept);
    if (next === null) return;
    try {
      await this.options.composer.write(next);
    } catch {
      // The goal exists. A block that could not be removed stays in the box for the person to clear.
    }
  }

  private async create(reviewed: ReviewedGoal): Promise<void> {
    const block = this.createBlock();
    if (block !== null) {
      await this.failCreate(
        new AppFailure({ code: "unavailable", message: block, retryable: false }).appError,
        reviewed,
      );
      return;
    }
    this.error = null;
    this.notice = null;
    this.setStatus("creating");
    const args: GoalArgs = {
      op: "create",
      objective: reviewed.objective,
      ...(reviewed.tokenBudget === undefined ? {} : { token_budget: reviewed.tokenBudget }),
    };
    try {
      await this.options.autonomy.goal(this.options.threadId, args, {
        signal: this.abortController.signal,
      });
    } catch (cause) {
      if (this.disposed) return;
      await this.failCreate(appError(cause, "The goal could not be created."), reviewed);
      return;
    }
    if (this.disposed) return;
    this.review = null;
    this.answers = EMPTY_GUIDED_ANSWERS;
    await this.removeKept();
    this.notice = CREATED_NOTICE;
    this.setStatus("created");
  }

  private async failCreate(error: AppError, reviewed: ReviewedGoal): Promise<void> {
    this.error = error;
    const kept = await this.keepGoal(reviewed);
    this.notice =
      kept === "goal"
        ? "The goal text is in the message box. Your answers stay here until the goal is created."
        : "The goal text could not be put in the message box. Keep this page open until the goal is created.";
    this.setStatus("failed");
  }

  /**
   * Why a goal cannot be created right now, or `null` when it can. These are omp's own refusals (rpc-goal.ts, `#create`,
   * v18.12.6): an enabled goal blocks a new one, and a paused goal must be resumed or dropped first.
   */
  private createBlock(): string | null {
    const capability = this.options.capabilities()?.[GOAL_CAPABILITY];
    if (capability?.state !== "available") {
      return "Goals cannot be created in this connection right now.";
    }
    const state = this.options.goal.getSnapshot();
    if (state?.enabled) return "A goal is already active. Drop it before creating another.";
    if (state?.goal.status === "paused") {
      return "Resume or drop the paused goal before creating another.";
    }
    return null;
  }

  private dialogOptions(): {
    readonly threadId: ThreadId;
    readonly signal: AbortSignal;
    readonly origin: "app";
    readonly restoreFocus?: FocusRestoreHandle;
  } {
    return {
      threadId: this.options.threadId,
      signal: this.abortController.signal,
      origin: "app",
      restoreFocus: this.options.restoreFocus,
    };
  }

  private setStatus(status: GuidedGoalStatus): void {
    this.status = status;
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    this.snapshot = this.deriveSnapshot();
    for (const listener of this.listeners) listener();
  }

  private deriveSnapshot(): GuidedGoalSnapshot {
    return {
      status: this.status,
      notice: this.notice,
      error: this.error,
      createReason: this.createBlock(),
    };
  }
}
