import type { RawTranscriptPart } from "@/modules/U1/copy";
import type { CopyAuthor, CopySourceMessage } from "../copy";
import { exactMarkdownOf } from "../copy/text";

/** Parts an export leaves out, as the copy picker does: hidden reasoning and tool calls. */
const LEFT_OUT: Readonly<Partial<Record<RawTranscriptPart["type"], true>>> = {
  reasoning: true,
  "tool-call": true,
};

const HEADING_BY_AUTHOR: Readonly<Record<CopyAuthor, string>> = { you: "You", omp: "omp" };

interface Section {
  /** The author's name, as the heading and the plain-text label. */
  readonly heading: string;
  readonly markdown: string;
  readonly plain: string;
}

/**
 * The sections of an export, in transcript order. Only a message with an author is a section: a tool's result,
 * a file mention or a summary is neither the person's nor omp's words, so it is left out. Markdown is each
 * message's exact source from U1.7's raw parts; plain text is each part's visible text, with no Markdown marks.
 */
function sectionsOf(messages: readonly CopySourceMessage[]): readonly Section[] {
  return messages.flatMap((message) => {
    if (message.author === undefined) return [];
    const markdown = exactMarkdownOf(message.raw.parts);
    if (markdown.trim() === "") return [];
    const plain = message.raw.parts
      .filter((part) => LEFT_OUT[part.type] !== true)
      .map((part) => part.plainText ?? part.markdown ?? "")
      .filter((text) => text.length > 0)
      .join("\n\n");
    return [{ heading: HEADING_BY_AUTHOR[message.author], markdown, plain }];
  });
}

/**
 * Messages as Markdown: each under its author's heading, in transcript order, with the message's exact source.
 * A single message is the same export with one section. No text gives an empty string.
 */
export function chatAsMarkdown(messages: readonly CopySourceMessage[]): string {
  return sectionsOf(messages)
    .map((section) => `## ${section.heading}\n\n${section.markdown}`)
    .join("\n\n");
}

/**
 * Messages as plain text: each part's `plainText` from U1.7, under its author's label. For a text part that
 * is the source text, so Markdown marks such as fences stay where omp wrote them.
 */
export function chatAsPlainText(messages: readonly CopySourceMessage[]): string {
  return sectionsOf(messages)
    .map((section) => `${section.heading}:\n${section.plain}`)
    .join("\n\n");
}
