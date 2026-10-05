import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SelectDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { CancelButton, DialogFrame, ErrorText, SubmitButton } from "./common";

export function SelectDialog({
  request,
  context,
}: {
  readonly request: SelectDialogRequest;
  readonly context: DialogRenderContext;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return request.options
      .map((label, index) => ({
        label,
        index,
        description: request.optionDetails?.[index]?.description,
      }))
      .filter(({ label, description }) => {
        if (!normalized) return true;
        return `${label} ${description ?? ""}`.toLocaleLowerCase().includes(normalized);
      });
  }, [query, request.options, request.optionDetails]);

  useEffect(() => {
    if (activeIndex >= filteredOptions.length)
      setActiveIndex(Math.max(0, filteredOptions.length - 1));
  }, [activeIndex, filteredOptions.length]);

  const submit = async () => {
    if (selected === null) {
      setError("Choose an option before continuing.");
      return;
    }
    await context.answer({ kind: "select", value: selected });
  };

  const move = (direction: 1 | -1) => {
    if (filteredOptions.length === 0) return;
    setActiveIndex(
      (current) => (current + direction + filteredOptions.length) % filteredOptions.length,
    );
  };

  return (
    <DialogFrame
      title={request.title}
      actions={
        <>
          <CancelButton onCancel={context.cancel} />
          <SubmitButton disabled={selected === null} onClick={() => void submit()}>
            Choose
          </SubmitButton>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          aria-label="Filter options"
          placeholder="Filter options"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const option = filteredOptions[activeIndex];
              if (option) setSelected(option.label);
            }
          }}
        />
        <div
          role="listbox"
          aria-label={request.title}
          className="flex max-h-64 flex-col gap-1 overflow-y-auto"
        >
          {filteredOptions.length === 0 ? (
            <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
              No matching options.
            </p>
          ) : (
            filteredOptions.map((option, index) => (
              <Button
                key={`${option.label}-${option.index}`}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={selected === option.label}
                variant={selected === option.label ? "secondary" : "ghost"}
                className="h-auto justify-start whitespace-normal px-3 py-2 text-start"
                onClick={() => {
                  setSelected(option.label);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    move(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    move(-1);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    setSelected(option.label);
                  }
                }}
                onFocus={() => setActiveIndex(index)}
              >
                <span className="flex flex-col gap-0.5">
                  <span>{option.label}</span>
                  {option.description ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </Button>
            ))
          )}
        </div>
        {error ? <ErrorText>{error}</ErrorText> : null}
      </form>
    </DialogFrame>
  );
}
