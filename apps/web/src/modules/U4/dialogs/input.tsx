import { useState } from "react";
import type { InputDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { CancelButton, DialogFrame, ErrorText, Input, isSecretInput, SubmitButton } from "./common";

export function InputDialog({
  request,
  context,
}: {
  readonly request: InputDialogRequest;
  readonly context: DialogRenderContext;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const secret = isSecretInput(request);

  const submit = async () => {
    const blank = value.trim().length === 0;
    if (blank && !request.optional) {
      setError("Enter a value before continuing.");
      return;
    }
    setError(null);
    await context.answer({ kind: "input", value: blank ? "" : value });
  };

  return (
    <DialogFrame
      title={request.title}
      actions={
        <>
          <CancelButton onCancel={context.cancel} />
          <SubmitButton onClick={() => void submit()}>Continue</SubmitButton>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Input
          autoFocus
          type={secret ? "password" : "text"}
          value={value}
          placeholder={request.placeholder}
          aria-label={request.title}
          aria-invalid={error ? "true" : undefined}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {request.optional ? (
          <p className="text-xs text-muted-foreground">Leave blank to skip.</p>
        ) : null}
        {secret ? (
          <p className="text-xs text-muted-foreground">Secret input is masked and is not echoed.</p>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
      </div>
    </DialogFrame>
  );
}
