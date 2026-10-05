import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { ConfirmDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { CancelButton, DialogFrame } from "./common";

export function ConfirmDialog({
  request,
  context,
}: {
  readonly request: ConfirmDialogRequest;
  readonly context: DialogRenderContext;
}) {
  const denyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => denyRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  const decide = async (confirmed: boolean) => {
    await context.answer({ kind: "confirm", confirmed });
  };

  return (
    <DialogFrame
      title={request.title}
      description={request.message}
      actions={
        <>
          <CancelButton onCancel={context.cancel} />
          <Button
            ref={denyRef}
            type="button"
            variant="outline"
            onClick={() => void decide(false)}
            data-confirmation-default="deny"
          >
            Deny
          </Button>
          <Button type="button" onClick={() => void decide(true)}>
            Confirm
          </Button>
        </>
      }
    >
      <p className="rounded-md border border-warning/30 bg-warning-surface p-3 text-sm text-warning-surface-foreground">
        Review this request before continuing. Deny is the safe default.
      </p>
    </DialogFrame>
  );
}
