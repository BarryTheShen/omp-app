import { MarkdownContent } from "../markdown";
import {
  describeSkillPrompt,
  SKILL_PROMPT_CUSTOM_TYPE,
  SkillPromptCard,
} from "./skill-prompt-card";

/** What `metadata.custom` carries for a custom message (set by R0's conversion). */
export interface CustomNoteSource {
  readonly customType: string;
  readonly details: unknown;
  /** The message's text, as omp saved it. */
  readonly text: string;
}

export interface CustomNoteView {
  /** A short plain-English heading, when the kind of message is known. */
  readonly heading: string | undefined;
  readonly body: string;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * omp wraps the text it sends the model in a tag of its own (`<system-notice>...</system-notice>`).
 * The tag is for the model: a note shows what is inside it. Text without such a wrapper is unchanged.
 */
export function withoutWrapper(text: string): string {
  const match = /^\s*<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>\s*$/i.exec(text);
  return match?.[2] ?? text.trim();
}

/**
 * The heading and body of one of omp's own messages. Headings come from the message's kind and its
 * `details` (never from reading omp's prose); an unknown kind shows its text under no heading.
 */
export function describeCustomMessage(source: CustomNoteSource): CustomNoteView {
  const { customType, details, text } = source;
  switch (customType) {
    case "irc:incoming": {
      const from = field(details, "from");
      const message = field(details, "message");
      return {
        heading: typeof from === "string" ? `Message from ${from}` : "Message from another agent",
        body: typeof message === "string" ? message : withoutWrapper(text),
      };
    }
    case "async-result":
      return { heading: "Background job finished", body: withoutWrapper(text) };
    case "advisor": {
      const notes = field(details, "notes");
      const lines = Array.isArray(notes)
        ? notes.flatMap((note) => {
            const line = field(note, "note");
            return typeof line === "string" ? [line] : [];
          })
        : [];
      return {
        heading: "Advisor note",
        body: lines.length > 0 ? lines.join("\n\n") : withoutWrapper(text),
      };
    }
    case "launch-completion":
      return { heading: "Process finished", body: withoutWrapper(text) };
    default:
      return { heading: undefined, body: withoutWrapper(text) };
  }
}

/** One of omp's own messages in the transcript: a muted note, its heading, and its text. */
export function CustomNote({ source }: { readonly source: CustomNoteSource }) {
  if (source.customType === SKILL_PROMPT_CUSTOM_TYPE) {
    return (
      <div
        className="flex min-w-0 flex-col"
        data-custom-type={source.customType}
        data-slot="u1-custom-note"
      >
        <SkillPromptCard view={describeSkillPrompt(source.details, source.text)} />
      </div>
    );
  }
  const { heading, body } = describeCustomMessage(source);
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-custom-type={source.customType}
      data-slot="u1-custom-note"
    >
      {heading !== undefined && (
        <p className="text-foreground text-xs font-medium" data-slot="u1-custom-note-heading">
          {heading}
        </p>
      )}
      <div className="max-h-80 min-w-0 overflow-auto" data-slot="u1-custom-note-body">
        <MarkdownContent text={body} variant="compact" />
      </div>
    </div>
  );
}
