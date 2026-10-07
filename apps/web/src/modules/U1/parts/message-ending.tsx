import { InlineError } from "@/components/blocks";

/** How an answer that did not finish normally ended. */
export type MessageEnding =
  | { readonly kind: "error"; readonly text: string | undefined }
  | { readonly kind: "interrupted" }
  | { readonly kind: "length" };

const MAX_ERROR_CHARACTERS = 600;

/**
 * The ending of an assistant message, from the status R0 gives it: an error with omp's own words, a
 * stop (the person's or omp's), or the length limit. A message that finished, or is still running,
 * has none.
 */
export function endingOf(message: {
  readonly role: string;
  readonly status?: { readonly type: string; readonly reason?: string; readonly error?: unknown };
}): MessageEnding | undefined {
  if (message.role !== "assistant" || message.status?.type !== "incomplete") return undefined;
  switch (message.status.reason) {
    case "error":
      return {
        kind: "error",
        text:
          typeof message.status.error === "string" && message.status.error.length > 0
            ? message.status.error
            : undefined,
      };
    case "cancelled":
      return { kind: "interrupted" };
    case "length":
      return { kind: "length" };
    default:
      return undefined;
  }
}

/** One line under an answer saying why it stopped, in plain words. */
export function MessageEndingNote({ ending }: { readonly ending: MessageEnding }) {
  switch (ending.kind) {
    case "error":
      return (
        <div data-ending="error" data-slot="u1-message-ending">
          <InlineError
            heading="The model stopped with an error"
            message={
              ending.text === undefined
                ? ""
                : ending.text.length > MAX_ERROR_CHARACTERS
                  ? `${ending.text.slice(0, MAX_ERROR_CHARACTERS)}…`
                  : ending.text
            }
            variant="message"
          />
        </div>
      );
    case "interrupted":
      return (
        <p
          className="text-muted-foreground mt-2 text-sm"
          data-ending="interrupted"
          data-slot="u1-message-ending"
        >
          Interrupted
        </p>
      );
    case "length":
      return (
        <p
          className="text-muted-foreground mt-2 text-sm"
          data-ending="length"
          data-slot="u1-message-ending"
        >
          Cut off at the length limit
        </p>
      );
  }
}
