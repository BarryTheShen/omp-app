import { TextMessagePartProvider } from "@assistant-ui/react";
import type { MarkdownTextProps } from "./markdown-text";
import { MarkdownText } from "./markdown-text";

export interface MarkdownContentProps {
  readonly text: string;
  readonly variant?: MarkdownTextProps["variant"];
}

/** Renders standalone Markdown through assistant-ui's text-part context and U1.4 sanitization. */
export function MarkdownContent({ text, variant = "default" }: MarkdownContentProps) {
  return (
    <TextMessagePartProvider text={text}>
      <MarkdownText variant={variant} />
    </TextMessagePartProvider>
  );
}
