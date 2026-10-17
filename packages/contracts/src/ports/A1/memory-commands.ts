import { z } from "zod";

/** `/memory` operations whose command_output format is parsed by A1.8. */
export const MemoryCommandOperation = z.enum([
  "view",
  "stats",
  "diagnose",
  "enqueue",
  "rebuild",
  "clear",
  "reset",
  "mm-list",
  "mm-show",
  "mm-history",
  "mm-refresh",
  "mm-reload",
  "mm-seed",
  "mm-delete",
]);
export type MemoryCommandOperation = z.infer<typeof MemoryCommandOperation>;

export const MemoryBackendId = z.enum(["off", "local", "hindsight", "mnemopi", "sharpshooter"]);
export type MemoryBackendId = z.infer<typeof MemoryBackendId>;

export const MemoryCommandUnavailableReason = z.enum([
  "backend-off",
  "backend-unavailable",
  "unsupported-acp",
]);
export type MemoryCommandUnavailableReason = z.infer<typeof MemoryCommandUnavailableReason>;

/** A stable result from one `/memory` command; the browser never classifies omp prose. */
export const MemoryCommandResult = z
  .strictObject({
    operation: MemoryCommandOperation,
    outcome: z.enum(["completed", "unavailable"]),
    text: z.string().max(200_000).optional(),
    backend: MemoryBackendId.optional(),
    reason: MemoryCommandUnavailableReason.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.outcome === "completed" &&
      value.text === undefined &&
      ["view", "stats", "diagnose"].includes(value.operation)
    ) {
      context.addIssue({ code: "custom", message: "this memory operation needs its typed text" });
    }
    if (value.outcome === "unavailable" && value.reason === undefined) {
      context.addIssue({
        code: "custom",
        message: "an unavailable memory operation needs a reason",
      });
    }
    if (value.reason === "backend-unavailable" && value.backend === undefined) {
      context.addIssue({
        code: "custom",
        message: "a backend-unavailable memory result needs its backend",
      });
    }
  });
export type MemoryCommandResult = z.infer<typeof MemoryCommandResult>;
