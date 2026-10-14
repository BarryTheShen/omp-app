import { useState } from "react";
import type { EditorDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import {
  ANSWER_NOT_SENT,
  CancelButton,
  DialogFrame,
  ErrorText,
  SubmitButton,
  Textarea,
} from "./common";

export function EditorDialog({
  request,
  context,
}: {
  readonly request: EditorDialogRequest;
  readonly context: DialogRenderContext;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [error, setError] = useState<string | null>(null);
  const readOnly = request.readOnly === true;

  const submit = async () => {
    setError(null);
    try {
      await context.answer({ kind: "editor", value });
    } catch {
      setError(ANSWER_NOT_SENT);
    }
  };

  return (
    <DialogFrame
      title={request.title}
      actions={
        readOnly ? (
          <SubmitButton onClick={() => void submit()}>Done</SubmitButton>
        ) : (
          <>
            <CancelButton onCancel={context.cancel} />
            <SubmitButton onClick={() => void submit()}>Save</SubmitButton>
          </>
        )
      }
    >
      {/* The text box takes the dialog's width, never its content's: a long link wraps inside the */}
      {/* dialog, so Done stays on it. Its height still follows the minimum and the resize handle. */}
      <Textarea
        autoFocus
        readOnly={readOnly}
        value={value}
        aria-label={request.title}
        className="min-h-40 resize-y [contain:inline-size]"
        onChange={(event) => {
          setValue(event.currentTarget.value);
          context.keepDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (readOnly) return;
          if (
            request.promptStyle &&
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            void submit();
          } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {readOnly ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          {request.promptStyle
            ? "Enter submits; use Shift+Enter for a new line."
            : "Ctrl/Cmd+Enter saves."}
        </p>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </DialogFrame>
  );
}
