import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SelectDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { ANSWER_NOT_SENT, CancelButton, DialogFrame, ErrorText, SubmitButton } from "./common";

/** The options a filter leaves listed: every option when the text is empty, otherwise those whose label or description contains it. */
function listedOptions(request: SelectDialogRequest, text: string) {
  const normalized = text.trim().toLocaleLowerCase();
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
}

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
  const showFilter = request.options.length > 7;
  const filteredOptions = useMemo(
    () => listedOptions(request, showFilter ? query : ""),
    [query, request, showFilter],
  );

  useEffect(() => {
    if (activeIndex >= filteredOptions.length)
      setActiveIndex(Math.max(0, filteredOptions.length - 1));
  }, [activeIndex, filteredOptions.length]);

  const submit = async () => {
    if (selected === null) {
      setError("Choose an option before continuing.");
      return;
    }
    setError(null);
    try {
      await context.answer({ kind: "select", value: selected });
    } catch {
      setError(ANSWER_NOT_SENT);
    }
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
        {showFilter ? (
          <Input
            aria-label="Filter options"
            placeholder="Filter options"
            value={query}
            onChange={(event) => {
              const nextQuery = event.currentTarget.value;
              setQuery(nextQuery);
              setActiveIndex(0);
              // A chosen option the new filter hides is unchosen, so Choose never sends an option that is not listed.
              if (
                selected !== null &&
                !listedOptions(request, nextQuery).some((option) => option.label === selected)
              ) {
                setSelected(null);
              }
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
        ) : null}
        <div
          role="listbox"
          aria-label={request.title}
          tabIndex={showFilter ? undefined : 0}
          onKeyDown={(event) => {
            if (showFilter || event.key.length !== 1) return;
            const index = filteredOptions.findIndex((option) =>
              option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
            );
            if (index < 0) return;
            event.preventDefault();
            setActiveIndex(index);
            setSelected(filteredOptions[index]?.label ?? null);
            setError(null);
          }}
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
                <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
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
