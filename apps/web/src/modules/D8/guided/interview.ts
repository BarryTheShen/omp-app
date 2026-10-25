/**
 * The guided goal interview's questions and the objective it builds. omp's `/guided-goal` asks for the five things
 * an objective must pin down before it creates a goal (`packages/coding-agent/src/prompts/goals/guided-goal-interview.md`,
 * the same at v18.6.1, v18.8.9 and v18.12.6): success criteria, verification, an attempt cap, scope boundaries and stop
 * conditions. The token budget is optional ("token budget when relevant"). The objective uses omp's five headings,
 * in omp's order.
 */

export const GUIDED_ANSWER_IDS = [
  "objective",
  "success",
  "verification",
  "attempts",
  "boundaries",
  "stop",
  "budget",
] as const;
export type AnswerId = (typeof GUIDED_ANSWER_IDS)[number];

export type GuidedAnswers = Readonly<Record<AnswerId, string>>;

export const EMPTY_GUIDED_ANSWERS: GuidedAnswers = Object.freeze({
  objective: "",
  success: "",
  verification: "",
  attempts: "",
  boundaries: "",
  stop: "",
  budget: "",
});

/** The dialog title of each answer, the budget included. */
const TITLES: Readonly<Record<AnswerId, string>> = {
  objective: "What should omp get done?",
  success: "How will you know it is done?",
  verification: "What should omp run to check its own work?",
  attempts: "How many attempts may omp make before it stops?",
  boundaries: "What may omp change, and what must it leave alone?",
  stop: "When should omp stop and ask you?",
  budget: "Token budget (optional)",
};

/** The optional token budget's dialog title. A blank answer means no limit. */
export const BUDGET_QUESTION = TITLES.budget;

export interface GuidedQuestion {
  readonly id: Exclude<AnswerId, "budget">;
  /** The question as the dialog's title shows it. */
  readonly question: string;
}

/** The required questions, in the order the interview asks them. The token budget comes after them. */
export const GUIDED_QUESTIONS: readonly GuidedQuestion[] = [
  { id: "objective", question: TITLES.objective },
  { id: "success", question: TITLES.success },
  { id: "verification", question: TITLES.verification },
  { id: "attempts", question: TITLES.attempts },
  { id: "boundaries", question: TITLES.boundaries },
  { id: "stop", question: TITLES.stop },
];

export type BudgetParse =
  | { readonly ok: true; readonly tokenBudget: number | undefined }
  | { readonly ok: false; readonly message: string };

/** A blank budget means no limit; anything else must be a whole number above zero. */
export function parseTokenBudget(text: string): BudgetParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, tokenBudget: undefined };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Enter a whole number of tokens, or leave this blank." };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, message: "Enter a token budget above zero, or leave this blank." };
  }
  return { ok: true, tokenBudget: value };
}

/**
 * The goal objective omp expects: its five headings, in order, each with the person's answer. The attempt cap is the
 * first line under "Stop conditions", so omp reads the cap and the stop conditions together.
 */
export function buildGoalObjective(answers: GuidedAnswers): string {
  return [
    "## Objective",
    answers.objective.trim(),
    "",
    "## Success criteria",
    answers.success.trim(),
    "",
    "## Verification",
    answers.verification.trim(),
    "",
    "## Boundaries",
    answers.boundaries.trim(),
    "",
    "## Stop conditions",
    `Attempt cap: ${answers.attempts.trim()}`,
    answers.stop.trim(),
  ].join("\n");
}

/** One entry the person was typing when a dialog closed without an answer. */
export interface PendingAnswer {
  readonly id: AnswerId;
  readonly text: string;
}

/**
 * The interview as plain text for the message box: each answer under its question, in the order asked. The pending
 * entry stands in for its question's answer, so the box holds what the person was typing. Empty when nothing is answered.
 */
export function interviewDraftText(answers: GuidedAnswers, pending?: PendingAnswer): string {
  const blocks: string[] = [];
  for (const id of GUIDED_ANSWER_IDS) {
    const value = (pending?.id === id ? pending.text : answers[id]).trim();
    if (value !== "") blocks.push(`${TITLES[id]}\n${value}`);
  }
  return blocks.join("\n\n");
}
