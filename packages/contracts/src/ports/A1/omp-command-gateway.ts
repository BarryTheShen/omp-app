import { z } from "zod";
import { definePort } from "../../core/envelope";
import { ThreadId } from "../../core/ids";
import { Timestamp } from "./shared";

/** A slash command as typed by the user, including its leading `/`. */
export const SlashCommand = z
  .string()
  .min(2)
  .regex(/^\/\S(?:[\s\S]*)$/, "expected a slash command");
export type SlashCommand = z.infer<typeof SlashCommand>;

export const CommandOutput = z.strictObject({
  text: z.string(),
  emittedAt: Timestamp.optional(),
});
export type CommandOutput = z.infer<typeof CommandOutput>;

export const SessionInfoUpdate = z.strictObject({
  sessionId: ThreadId,
  title: z.string().optional(),
});
export type SessionInfoUpdate = z.infer<typeof SessionInfoUpdate>;

/** Safe model metadata from a config_update; credentials and provider headers are excluded. */
export const CommandModelUpdate = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  api: z.string().min(1).optional(),
  reasoning: z.boolean().optional(),
});
export type CommandModelUpdate = z.infer<typeof CommandModelUpdate>;

export const ConfigInfoUpdate = z.strictObject({
  model: CommandModelUpdate.optional(),
  thinkingLevel: z
    .enum(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional(),
});
export type ConfigInfoUpdate = z.infer<typeof ConfigInfoUpdate>;

export const CommandRunArgs = z.strictObject({
  threadId: ThreadId,
  command: SlashCommand,
});
export type CommandRunArgs = z.infer<typeof CommandRunArgs>;

/** Aggregates command_output, session_info_update and config_update without conflating settlement. */
export const CommandRunResult = z.strictObject({
  command: SlashCommand,
  status: z.enum(["completed", "aborted"]),
  agentInvoked: z.boolean(),
  /** The `prompt_result.sessionSettled` bit; a later session_settled event is separate. */
  promptSettled: z.boolean(),
  /** True only after the distinct `session_settled` frame has arrived. */
  sessionSettled: z.boolean(),
  outputs: z.array(CommandOutput),
  sessionUpdates: z.array(SessionInfoUpdate),
  configUpdates: z.array(ConfigInfoUpdate),
});
export type CommandRunResult = z.infer<typeof CommandRunResult>;

export const CommandOutputEvent = z.strictObject({
  threadId: ThreadId,
  output: CommandOutput,
});
export type CommandOutputEvent = z.infer<typeof CommandOutputEvent>;

export const OmpCommandGateway = definePort({
  name: "A1.ompCommandGateway",
  methods: {
    run: {
      args: CommandRunArgs,
      result: CommandRunResult,
      capability: "host.command-gateway",
    },
  },
  events: {
    output: {
      payload: CommandOutputEvent,
      capability: "host.command-gateway",
    },
  },
});
