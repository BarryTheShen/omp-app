import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConfirmDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { ANSWER_NOT_SENT, CancelButton, DialogFrame, ErrorText } from "./common";

export function ConfirmDialog({
  request,
  context,
}: {
  readonly request: ConfirmDialogRequest;
  readonly context: DialogRenderContext;
}) {
  const defaultRef = useRef<HTMLButtonElement>(null);
  const appQuestion = request.variant === "question";
  useEffect(() => {
    const timer = setTimeout(() => defaultRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  const [error, setError] = useState<string | null>(
    context.answerNotSent === true ? ANSWER_NOT_SENT : null,
  );
  const decide = async (confirmed: boolean) => {
    setError(null);
    try {
      await context.answer({ kind: "confirm", confirmed });
    } catch {
      setError(ANSWER_NOT_SENT);
    }
  };

  return (
    <DialogFrame
      title={request.title}
      description={request.message}
      actions={
        <>
          {appQuestion ? (
            <Button
              ref={defaultRef}
              type="button"
              variant="outline"
              onClick={() => void context.cancel()}
              data-confirmation-default="cancel"
            >
              Cancel
            </Button>
          ) : (
            <CancelButton onCancel={context.cancel} />
          )}
          {!appQuestion ? (
            <Button
              ref={defaultRef}
              type="button"
              variant="outline"
              onClick={() => void decide(false)}
              data-confirmation-default="deny"
            >
              Deny
            </Button>
          ) : null}
          <Button type="button" onClick={() => void decide(true)}>
            Confirm
          </Button>
        </>
      }
    >
      {!appQuestion ? (
        <p className="rounded-md border border-warning/30 bg-warning-surface p-3 text-sm text-warning-surface-foreground">
          Review this request before continuing. Deny is the safe default.
        </p>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </DialogFrame>
  );
}
