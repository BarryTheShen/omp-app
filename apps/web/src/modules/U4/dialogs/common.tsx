import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ConfirmDialogRequest, InputDialogRequest } from "../contract";
export function DialogFrame({
  title,
  description,
  children,
  actions,
  labelledBy,
  notice,
}: {
  readonly title: string;
  readonly description?: string;
  /** A line under the header that stays in view while the body scrolls, such as a time left. */
  readonly notice?: ReactNode;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly labelledBy?: string;
}) {
  return (
    <div className="flex max-h-[70dvh] flex-col gap-4" data-testid="dialog-frame">
      <header className="flex flex-col gap-1">
        <h2
          id={labelledBy}
          className="text-base font-medium text-popover-foreground [overflow-wrap:anywhere]"
        >
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
        ) : null}
        {notice ? <div className="text-sm text-muted-foreground">{notice}</div> : null}
      </header>
      <div className="min-h-0 overflow-y-auto text-sm">{children}</div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        {actions}
      </footer>
    </div>
  );
}
export function CancelButton({ onCancel }: { readonly onCancel: () => void | Promise<void> }) {
  return (
    <Button type="button" variant="outline" onClick={() => void onCancel()}>
      Cancel
    </Button>
  );
}

export function SubmitButton({
  children = "Submit",
  disabled = false,
  onClick,
}: {
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}) {
  return (
    <Button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

/** What a dialog says when its answer did not reach omp. The dialog stays open, so the same answer can be sent again. */
export const ANSWER_NOT_SENT = "Sending your answer failed. Try again.";

export function ErrorText({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-danger" data-testid="dialog-error">
      {children}
    </p>
  );
}

export function isSecretInput(request: InputDialogRequest): boolean {
  const candidate: unknown = request;
  if (typeof candidate !== "object" || candidate === null) return false;
  if ("secret" in candidate && candidate.secret === true) return true;
  return "isSecret" in candidate && candidate.isSecret === true;
}

export function isDestructiveConfirm(request: ConfirmDialogRequest): boolean {
  // The released confirm wire has no destructive bit. Confirm therefore always starts on deny;
  // downstream callers may still style this as a destructive confirmation without changing wire data.
  return request.kind === "confirm";
}

export { Input, Textarea };
