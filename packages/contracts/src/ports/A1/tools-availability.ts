import { z } from "zod";
import { CapabilityKey } from "../../core/capabilities";
import { ThreadId } from "../../core/ids";

/** Browser-visible execution slots shared with D7.1; this is a result of omp's /tools inventory. */
export const ToolAvailabilityMode = z.enum([
  "default",
  "browser",
  "computer",
  "extended-context",
  "fast",
  "force",
  "prewalk",
  "shake",
  "skillful",
  "slow",
  "vision",
]);
export type ToolAvailabilityMode = z.infer<typeof ToolAvailabilityMode>;

export const ToolAvailabilityState = z.enum(["available", "fallback", "unavailable", "unknown"]);
export type ToolAvailabilityState = z.infer<typeof ToolAvailabilityState>;

export const ToolAvailability = z.strictObject({
  tool: z.string().min(1),
  state: ToolAvailabilityState,
  mode: ToolAvailabilityMode.optional(),
  capability: CapabilityKey.optional(),
  reason: z.string().min(1).optional(),
});
export type ToolAvailability = z.infer<typeof ToolAvailability>;

export const ToolsAvailabilityArgs = z.strictObject({ threadId: ThreadId });
export type ToolsAvailabilityArgs = z.infer<typeof ToolsAvailabilityArgs>;

export const ToolsAvailabilityResult = z.strictObject({
  tools: z.array(ToolAvailability),
});
export type ToolsAvailabilityResult = z.infer<typeof ToolsAvailabilityResult>;
