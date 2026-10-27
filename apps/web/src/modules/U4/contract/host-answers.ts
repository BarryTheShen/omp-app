/**
 * The answers to the chat host's calls of the app's tools and URI schemes (`tool.call`, `uri.read`, `uri.write`; AP9,
 * `research/modules/U4.md` §5), in the host's shapes (SDK plan H5.4d): omp's tool result for a call, a call's progress,
 * and omp's URI result for a read or write. A0 checks and carries them, I1 owns the registrations, U4 owns this
 * request and answer path, and T7 owns the generic fallback rendering (`PLAN.md` lines 88-89).
 */

import { HostCallId } from "@omp-app/contracts";
import {
  HostToolUpdateParams,
  ToolCallAnswer,
  UriReadAnswer,
  UriWriteAnswer,
} from "@omp-app/contracts/chat-host";
import { z } from "zod";

export const HostRequestAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("tool-update"),
    requestId: HostCallId,
    partialResult: HostToolUpdateParams.shape.partialResult,
  }),
  z.strictObject({
    kind: z.literal("tool-result"),
    requestId: HostCallId,
    result: ToolCallAnswer,
  }),
  z.strictObject({
    kind: z.literal("uri-result"),
    requestId: HostCallId,
    result: z.union([UriReadAnswer, UriWriteAnswer]),
  }),
]);
export type HostRequestAnswer = z.infer<typeof HostRequestAnswerSchema>;

/**
 * Submits one host tool or URI answer, and resolves a pending request the UI abandons so it never hangs silently
 * (`modules/U4/README.md` Plan item 5). Checks that the id is pending before delegating to R0.5's typed actions; a UI
 * component never builds an answer by hand.
 */
export interface HostRequestAnswerAdapter {
  submit(answer: HostRequestAnswer, options?: { readonly signal?: AbortSignal }): Promise<void>;
  cancel(
    requestId: HostCallId,
    reason: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

/**
 * How a tool call the UI abandons (a dismissed fallback card, a thread switch) is answered: a failed result with the
 * reason, since the app can never make up a tool's output.
 */
export function cancelledHostToolResult(requestId: HostCallId, reason: string): HostRequestAnswer {
  return {
    kind: "tool-result",
    requestId,
    result: { content: [{ type: "text", text: reason }], isError: true },
  };
}

/** The same for a URI read or write: omp fails it with the reason. */
export function cancelledHostUriResult(requestId: HostCallId, reason: string): HostRequestAnswer {
  return { kind: "uri-result", requestId, result: { isError: true, error: reason } };
}
