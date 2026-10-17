import { z } from "zod";
import { SubagentLifecyclePayloadSchema } from "@/modules/P1/contract";
import { GoalUpdatedEventSchema } from "../contract";

export const SyntheticReconnectStateSchema = z.object({
  kind: z.enum(["goal", "worker", "gateway"]),
  before: z.string(),
  during: z.literal("reconnecting"),
  after: z.string(),
});

export type SyntheticReconnectState = z.infer<typeof SyntheticReconnectStateSchema>;

/** D8's own goal frame and P1's own subagent frame, with the sequence number this synthetic stream adds. */
const SyntheticGoalUpdatedFrameSchema = GoalUpdatedEventSchema.extend({ seq: z.number() });
const SyntheticSubagentLifecycleFrameSchema = z.object({
  type: z.literal("subagent_lifecycle"),
  payload: SubagentLifecyclePayloadSchema,
  seq: z.number(),
});

export const SyntheticReconnectFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connection"),
    state: z.enum(["open", "closed", "reconnecting"]),
    seq: z.number().optional(),
    afterSeq: z.number().optional(),
  }),
  SyntheticGoalUpdatedFrameSchema,
  SyntheticSubagentLifecycleFrameSchema,
  z.object({
    type: z.literal("command_result"),
    command: z.string(),
    status: z.enum(["completed", "aborted"]),
    seq: z.number(),
  }),
  z.object({
    type: z.literal("reconnect_state"),
    state: SyntheticReconnectStateSchema,
  }),
]);

export type SyntheticReconnectFrame = z.infer<typeof SyntheticReconnectFrameSchema>;

/** Invented D8 state examples; these are not a real OMP capture. */
export const SYNTHETIC_RECONNECT_STATES: readonly SyntheticReconnectState[] = [
  { kind: "goal", before: "active", during: "reconnecting", after: "active" },
  { kind: "worker", before: "running", during: "reconnecting", after: "completed" },
  { kind: "gateway", before: "completed", during: "reconnecting", after: "completed" },
].map((state) => SyntheticReconnectStateSchema.parse(state));
