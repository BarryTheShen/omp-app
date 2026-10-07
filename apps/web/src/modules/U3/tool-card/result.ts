import { z } from "zod";

/**
 * What omp returns from a tool: `{ content: [{ type: "text", text }], details }`. `content` is the
 * text the model saw; `details` is what the tool computed for display (a read's lines, an edit's
 * diff, a search's answer). A card decodes `details`, and shows `text` when there are none.
 * R0 hands every card this envelope, in a finished call and in a streamed update alike.
 */
export interface SplitToolResult {
  /** The text parts of `content`, joined; "" when there are none. */
  readonly text: string;
  /** `details` of an envelope; undefined for a result that is not one, or that carries none. */
  readonly details: unknown;
  /** True when the result had omp's envelope shape (a `content` list or `details`). */
  readonly isEnvelope: boolean;
}

const TextPart = z.looseObject({ type: z.literal("text"), text: z.string() });
const Envelope = z.looseObject({
  content: z.array(z.unknown()).optional(),
  details: z.unknown().optional(),
});

export function splitToolResult(result: unknown): SplitToolResult {
  if (typeof result === "string") return { text: result, details: undefined, isEnvelope: false };
  const envelope = Envelope.safeParse(result);
  if (!envelope.success || !("content" in envelope.data || "details" in envelope.data)) {
    return { text: "", details: undefined, isEnvelope: false };
  }
  const text = (envelope.data.content ?? [])
    .flatMap((part) => {
      const parsed = TextPart.safeParse(part);
      return parsed.success ? [parsed.data.text] : [];
    })
    .join("\n");
  return { text, details: envelope.data.details, isEnvelope: true };
}

/**
 * What a card decodes as its details: an envelope's `details` (`{}` when it has none, so the card
 * still renders what the text holds), and any other value as it is (a streamed preview, a string).
 */
export function detailsSource(result: unknown): unknown {
  const split = splitToolResult(result);
  return split.isEnvelope ? (split.details ?? {}) : result;
}
