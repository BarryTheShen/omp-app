import type { Goal } from "../contract";
import type { RecordedFixture } from "./recorded";

/** The goal omp returned when a goal was created and was still active (T7's recorded goal tool result). */
export const RECORDED_GOAL_CREATED: RecordedFixture<Goal> = {
  name: "goal: a goal created and still active",
  origin: "modules/T7/fixtures/real-results.ts:38-67",
  value: {
    id: "157cf7c0fcd00f8c",
    objective: "Choose between two model sizes with measured evidence on both engines.",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1789104882000,
    updatedAt: 1789104882000,
  },
};

/** The goal omp returned after it was dropped, with its tokens used (T7's recorded goal tool result). */
export const RECORDED_GOAL_DROPPED: RecordedFixture<Goal> = {
  name: "goal: a goal dropped after its tokens were used",
  origin: "modules/T7/fixtures/real-results.ts:9-36",
  value: {
    id: "157b0ac9f9500f3f",
    objective: "Keep the service running at 40 tokens per second.",
    status: "dropped",
    tokensUsed: 6059194,
    timeUsedSeconds: 33048,
    createdAt: 1789104871397,
    updatedAt: 1789145356095,
  },
};

/**
 * omp's refusal for the goal tool when a goal is created while the session already has one (T7's recorded tool result,
 * `isError`). The app's `goal` method refuses the same case with another text: CREATE_REFUSED_ACTIVE_GOAL.
 */
export const RECORDED_CREATE_REFUSED: RecordedFixture<string> = {
  name: "goal: a new goal refused because one exists",
  origin: "modules/T7/fixtures/real-results.ts:69-80",
  value: "cannot create a new goal because this session already has a goal",
};

/**
 * The chat host's refusal of the `goal` method's create while a goal is active
 * (`packages/server/src/chat-host/goal.ts`, the text omp's RPC goal code threw: omp v18.8.9 `rpc-goal.ts:250`).
 */
export const CREATE_REFUSED_ACTIVE_GOAL =
  "A goal is already active. Drop it before creating another.";

/**
 * omp's `goal.continuationModes` setting as the app reads it. The chat host continues a goal when the setting lists `rpc`,
 * the entry omp's RPC hosts read (`packages/server/src/chat-host/goal.ts`, `CONTINUATION_MODE`); without it, it does
 * not (omp v18.6.1 `docs_rpc.md:475-476`). `withoutRpc` is omp's default for the setting (omp v18.8.9 `settings.ts:27`,
 * read by the main agent; that file is not in the local copies). `unreadable` stands for the app failing to read the
 * setting.
 */
export const CONTINUATION_MODE_SETTINGS = {
  withRpc: ["rpc"],
  withoutRpc: ["interactive"],
  unreadable: null,
} as const;
