import { z } from "zod";
import { definePort } from "../../core/envelope";

export const ProviderErrorArgs = z.strictObject({ text: z.string() });
export type ProviderErrorArgs = z.infer<typeof ProviderErrorArgs>;

/** A provider error after the server has removed omp-local request diagnostics. */
export const ProviderErrorResult = z.strictObject({
  message: z.string(),
  requestLogSaveFailureReason: z.string().min(1).optional(),
});
export type ProviderErrorResult = z.infer<typeof ProviderErrorResult>;

export const ProviderErrorPort = definePort({
  name: "A1.providerError",
  methods: {
    parse: {
      args: ProviderErrorArgs,
      result: ProviderErrorResult,
    },
  },
  events: {},
});
