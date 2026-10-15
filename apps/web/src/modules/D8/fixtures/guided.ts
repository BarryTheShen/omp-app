import { GoalCreateRequestSchema, type GoalRpcResult } from "../contract";
import { buildGoalObjective, EMPTY_GUIDED_ANSWERS, type GuidedAnswers } from "../guided/interview";
import { RECORDED_GOAL_CREATED, RPC_CREATE_REFUSED_ACTIVE_GOAL } from "./goal";

/** Every required answer and the token budget, as the person types them in the interview's dialogs. */
export const GUIDED_ANSWERS_SUCCESS: GuidedAnswers = {
  ...EMPTY_GUIDED_ANSWERS,
  objective: "Ship the release notes for the next version.",
  success: "The notes list every change merged since the last release.",
  verification: "Compare the notes with the merged pull requests.",
  attempts: "3",
  boundaries: "Do not edit the release process.",
  stop: "Stop when the notes match the merged pull requests.",
  budget: "5000",
};

/** Only the first question answered: an interview cancelled there creates nothing. */
export const GUIDED_ANSWERS_PARTIAL: GuidedAnswers = {
  ...EMPTY_GUIDED_ANSWERS,
  objective: "Ship the release notes for the next version.",
};

/** The `goal.create` request a finished interview sends: the five-heading objective and the budget. */
export const GUIDED_CREATE_REQUEST = GoalCreateRequestSchema.parse({
  objective: buildGoalObjective(GUIDED_ANSWERS_SUCCESS),
  token_budget: 5000,
});

/**
 * omp's reply to that create, in the shape its RPC answers with: `{ goal, state }`. It is constructed, not recorded: the
 * goal is the recorded goal (T7) with the budget this interview sent, and `state` is null. The RPC reply is not recorded
 * on main; issue 1671 covers goal create over RPC.
 */
export const GUIDED_CREATE_REPLY: GoalRpcResult = {
  goal: { ...RECORDED_GOAL_CREATED.value, tokenBudget: 5000 },
  state: null,
};

/** Success: the request is sent, and omp answers with the goal it created. */
export const GUIDED_INTERVIEW_SUCCEEDED = {
  answers: GUIDED_ANSWERS_SUCCESS,
  createRequest: GUIDED_CREATE_REQUEST,
  createReply: GUIDED_CREATE_REPLY,
} as const;

/** Cancelled before the interview finished: no create request is sent. */
export const GUIDED_INTERVIEW_CANCELLED = {
  answers: GUIDED_ANSWERS_PARTIAL,
  createRequest: null,
} as const;

/**
 * Refused: the request is sent and omp refuses it, because the session already has an active goal. The text is omp's RPC
 * refusal, the same text the interview shows before a create (`createReason`). It is not recorded on main.
 */
export const GUIDED_INTERVIEW_REFUSED = {
  answers: GUIDED_ANSWERS_SUCCESS,
  createRequest: GUIDED_CREATE_REQUEST,
  createRefusal: RPC_CREATE_REFUSED_ACTIVE_GOAL,
} as const;
