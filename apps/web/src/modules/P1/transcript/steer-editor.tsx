import { type KeyboardEvent, useId } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type SteerKey, steerKeyOf } from "./steer";

export interface SteerEditorProps {
  readonly text: string;
  readonly sending: boolean;
  readonly canSend: boolean;
  /** Why the editor is off, in plain words; undefined while a running worker can take a message. */
  readonly unavailable: string | undefined;
  readonly failure: string | undefined;
  readonly onTextChange: (text: string) => void;
  readonly onKey: (key: SteerKey) => void;
  readonly onSend: () => void;
}

/**
 * The one editor for a running worker. The view only maps keys to the editor's keys; what Enter, Escape
 * and Left do is decided by the hook, and the send itself is the hook's `steer` call.
 */
export function SteerEditor({
  text,
  sending,
  canSend,
  unavailable,
  failure,
  onTextChange,
  onKey,
  onSend,
}: SteerEditorProps) {
  const fieldId = useId();
  const hintId = useId();
  const failureId = useId();
  const describedBy = failure === undefined ? hintId : `${hintId} ${failureId}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const key = steerKeyOf({
      key: event.key,
      shiftKey: event.shiftKey,
      composing: event.nativeEvent.isComposing,
    });
    if (key === undefined || key === "shift-enter") return;
    if (key === "enter" || key === "escape") event.preventDefault();
    if (key === "escape") event.stopPropagation();
    onKey(key);
  };

  return (
    <form
      className="border-border bg-background flex min-w-0 flex-col gap-2 border-t px-4 py-3"
      data-slot="p1-steer-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <label className="text-muted-foreground text-xs font-medium" htmlFor={fieldId}>
        Message to this worker
      </label>
      <Textarea
        aria-describedby={describedBy}
        aria-invalid={failure !== undefined}
        disabled={unavailable !== undefined}
        id={fieldId}
        name="message"
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write what the worker should do next"
        rows={2}
        value={text}
      />
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 text-xs" id={hintId}>
          {unavailable ??
            "Enter sends. Shift+Enter starts a new line. Esc clears the text, then leaves."}
        </p>
        <Button disabled={!canSend} size="sm" type="submit">
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
      {failure !== undefined ? (
        <p className="text-destructive text-xs" id={failureId} role="alert">
          {failure}
        </p>
      ) : null}
    </form>
  );
}
