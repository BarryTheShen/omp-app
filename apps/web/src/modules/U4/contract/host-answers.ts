/**
 * Host tool/URI answer frames (AP9; `research/modules/U4.md` §5). A0 validates and transports the
 * frames, I1 owns host tool/URI registration, U4 owns this request/answer UI, and T7 owns generic
 * fallback rendering (`PLAN.md` lines 88-89). These types are the answer half of the sibling
 * `host_tool_call`/`host_uri_request` protocol; U4 never registers a scheme or constructs an
 * arbitrary wire frame by hand.
 */

import type { OmpWire } from "@omp-app/contracts";
import { HostCallId } from "@omp-app/contracts";
import { z } from "zod";

export type HostToolResultPayload = OmpWire.HostToolResultPayload;
export type HostUriResultPayload = Omit<OmpWire.HostUriResult, "type" | "id">;

/** A duck-typed runtime check: U4 never re-declares the wire's `UserContent` union, so this
 *  confirms only the shape the answer path actually reads (an array under `content`). */
function isHostToolResultPayload(value: unknown): value is HostToolResultPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function isHostUriResultPayload(value: unknown): value is HostUriResultPayload {
  return typeof value === "object" && value !== null;
}

const HostToolResultPayloadSchema = z.custom<HostToolResultPayload>(
  isHostToolResultPayload,
  "expected a host tool result payload",
);
const HostUriResultPayloadSchema = z.custom<HostUriResultPayload>(
  isHostUriResultPayload,
  "expected a host URI result payload",
);

export const HostRequestAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("tool-update"),
    requestId: HostCallId,
    partialResult: HostToolResultPayloadSchema,
  }),
  z.strictObject({
    kind: z.literal("tool-result"),
    requestId: HostCallId,
    result: HostToolResultPayloadSchema,
  }),
  z.strictObject({
    kind: z.literal("uri-result"),
    requestId: HostCallId,
    result: HostUriResultPayloadSchema,
  }),
]);
export type HostRequestAnswer = z.infer<typeof HostRequestAnswerSchema>;

/**
 * Submits one host-tool/URI answer, and resolves a pending request the UI abandons so it never
 * hangs silently (`modules/U4/README.md` Plan item 5). Validates pending-id ownership before
 * delegating to R0.5's typed actions; never lets a UI component build an arbitrary wire frame.
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
 * The one wire-legal way to resolve a host tool call the UI abandons (a dismissed fallback card,
 * a thread switch): an error-shaped result, since the host can never fabricate success content.
 */
export function cancelledHostToolResult(requestId: HostCallId, reason: string): HostRequestAnswer {
  return {
    kind: "tool-result",
    requestId,
    result: { content: [{ type: "text", text: reason }], isError: true },
  };
}

/** The matching abandonment shape for a host URI request. */
export function cancelledHostUriResult(requestId: HostCallId, reason: string): HostRequestAnswer {
  return { kind: "uri-result", requestId, result: { isError: true, error: reason } };
}
