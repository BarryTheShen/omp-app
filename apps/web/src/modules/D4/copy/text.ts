import { AppFailure } from "@omp-app/contracts";
import type { RawTranscriptPart } from "@/modules/U1/copy";
import type { TranscriptCopyTarget } from "../contract";
import { fencedBlocks, withoutFinalLineEnding } from "./fences";

/** Part kinds a message's copy leaves out: hidden reasoning and tool calls, as U1's copyText leaves them out. */
const LEFT_OUT: Readonly<Partial<Record<RawTranscriptPart["type"], true>>> = {
  reasoning: true,
  "tool-call": true,
};

/** A part's source text: the exact Markdown U1.7 kept, or the plain text when there is no Markdown. */
export function sourceTextOf(part: RawTranscriptPart): string {
  return part.markdown ?? part.plainText ?? "";
}

/**
 * A message's exact Markdown: each copyable part's source, in order, joined by a blank line (the join
 * U1's copyText uses). Hidden reasoning and tool calls are left out.
 */
export function exactMarkdownOf(parts: readonly RawTranscriptPart[]): string {
  return parts
    .filter((part) => LEFT_OUT[part.type] !== true)
    .map(sourceTextOf)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * The exact text a copy target names. A message copies its exact Markdown. A whole command or code part
 * copies its text without the final line ending, as a fenced block does. A fenced block copies its
 * content, and a range copies characters of the block, or of the part when there is no block. Text that
 * is empty or missing is refused, never copied as nothing.
 */
export function textForTarget(
  target: TranscriptCopyTarget,
  parts: readonly RawTranscriptPart[],
): string {
  const text = target.kind === "message" ? exactMarkdownOf(parts) : partTextOf(target, parts);
  if (text.trim() === "") throw refusal("invalid_args", "There is no text to copy here.");
  return text;
}

function partTextOf(
  target: Exclude<TranscriptCopyTarget, { readonly kind: "message" }>,
  parts: readonly RawTranscriptPart[],
): string {
  const part = parts[0];
  if (part === undefined) throw refusal("not_found", "That part of the message is no longer here.");
  if (target.blockIndex === undefined && target.range === undefined) {
    return withoutFinalLineEnding(sourceTextOf(part));
  }
  if (part.type !== "text") {
    throw refusal("invalid_args", "That part has no fenced code block or range to copy.");
  }
  let scope = sourceTextOf(part);
  if (target.blockIndex !== undefined) {
    const block = fencedBlocks(scope)[target.blockIndex];
    if (block === undefined) {
      throw refusal("not_found", "That code block is no longer in this message.");
    }
    scope = block.content;
  }
  if (target.range === undefined) return scope;
  if (target.range.end > scope.length) {
    throw refusal("invalid_args", "The selected range is longer than the text it points into.");
  }
  return scope.slice(target.range.start, target.range.end);
}

/** A typed refusal for a copy the browser cannot make; the code says which side was at fault. */
export function refusal(code: "invalid_args" | "not_found", message: string): AppFailure {
  return new AppFailure({ code, message, retryable: false });
}
