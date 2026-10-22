import { useEffect, useMemo, useRef, useState } from "react";
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
  // The highlighted option is the one Enter chooses. Focus moves with it when the focus is on the list.
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(
    context.answerNotSent === true ? ANSWER_NOT_SENT : null,
  );
  // Set while an answer is being sent and once one is accepted, so a second Enter or Choose never answers twice.
  const answeredRef = useRef(false);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const showFilter = request.options.length > 7;
  const filteredOptions = useMemo(
    () => listedOptions(request, showFilter ? query : ""),
    [query, request, showFilter],
  );

  useEffect(() => {
    if (activeIndex >= filteredOptions.length)
      setActiveIndex(Math.max(0, filteredOptions.length - 1));
  }, [activeIndex, filteredOptions.length]);

  /** Sends the answer now, as omp's select does on Enter. A send that fails re-arms the answer, so the same one can go again. */
  const choose = async (value: string) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    setSelected(value);
    setError(null);
    try {
      await context.answer({ kind: "select", value });
    } catch {
      answeredRef.current = false;
      setError(ANSWER_NOT_SENT);
    }
  };

  const submit = () => {
    if (selected === null) {
      setError("Choose an option before continuing.");
      return;
    }
    void choose(selected);
  };

  /** Moves the highlight one listed option, wrapping at both ends. Focus moves with it when it is on the list. */
  const moveHighlight = (direction: 1 | -1, focusOption: boolean) => {
    if (filteredOptions.length === 0) return;
    const next = (activeIndex + direction + filteredOptions.length) % filteredOptions.length;
    setActiveIndex(next);
    if (focusOption) optionRefs.current[next]?.focus();
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
                moveHighlight(1, false);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveHighlight(-1, false);
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                // Enter chooses the highlighted option and never submits the form. A held Enter is ignored.
                event.preventDefault();
                const option = filteredOptions[activeIndex];
                if (option && !event.repeat) void choose(option.label);
              }
            }}
          />
        ) : null}
        <div
          role="listbox"
          aria-label={request.title}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveHighlight(event.key === "ArrowDown" ? 1 : -1, true);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const option = filteredOptions[activeIndex];
              if (option && !event.repeat) void choose(option.label);
            } else if (!showFilter && event.key.length === 1) {
              const index = filteredOptions.findIndex((option) =>
                option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
              );
              if (index < 0) return;
              event.preventDefault();
              setActiveIndex(index);
              optionRefs.current[index]?.focus();
              setSelected(filteredOptions[index]?.label ?? null);
              setError(null);
            }
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
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={selected === option.label}
                data-highlighted={index === activeIndex ? "" : undefined}
                variant={selected === option.label ? "secondary" : "ghost"}
                className="h-auto justify-start whitespace-normal px-3 py-2 text-start data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                onClick={() => {
                  setActiveIndex(index);
                  setSelected(option.label);
                  setError(null);
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
