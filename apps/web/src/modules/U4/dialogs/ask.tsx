import { CheckIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ASK_DIALOG_HEADING, type AskDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import {
  ANSWER_NOT_SENT,
  CancelButton,
  DialogFrame,
  ErrorText,
  Input,
  SubmitButton,
} from "./common";

type AnswerDraft = { selectedOptions: string[]; customInput: string };

function emptyDraft(): AnswerDraft {
  return { selectedOptions: [], customInput: "" };
}

function hasAnswer(answer: AnswerDraft | undefined): boolean {
  return Boolean(
    answer && (answer.selectedOptions.length > 0 || answer.customInput.trim().length > 0),
  );
}

/** The option an arrow key, Home or End moves to among `count` options; undefined for any other key. */
function nextOptionIndex(key: string, current: number, count: number): number | undefined {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/** The visible mark of an option: a box for a question with several answers, a dot for one with a single answer. */
function OptionMark({ multi, selected }: { readonly multi: boolean; readonly selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-selected={selected ? "true" : "false"}
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
        multi ? "rounded-xs" : "rounded-full",
        selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground",
      )}
    >
      {selected && multi ? <CheckIcon className="size-3" /> : null}
      {selected && !multi ? <span className="size-1.5 rounded-full bg-current" /> : null}
    </span>
  );
}

/**
 * The time left before the host settles this question on its timer, and what omp answers then. omp's own rule
 * (`timedOutAskDialogResult` in omp) is the recommended option, or the first option when none is recommended.
 */
function AskCountdown({ deadlineAt }: { readonly deadlineAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((deadlineAt - now) / 1000));
  return (
    <>
      <p role="timer">{`Time left: ${seconds} ${seconds === 1 ? "second" : "seconds"}.`}</p>
      <p>
        When time runs out, omp uses its recommended answer for each question, or the first option
        when none is recommended.
      </p>
    </>
  );
}

export function AskDialog({
  request,
  context,
}: {
  readonly request: AskDialogRequest;
  readonly context: DialogRenderContext;
}) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [review, setReview] = useState(false);
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const question = request.questions[questionIndex];
  const currentDraft = drafts[question?.id ?? ""] ?? emptyDraft();
  const answers = useMemo(
    () =>
      request.questions.map((item) => {
        const answer = drafts[item.id] ?? emptyDraft();
        return {
          id: item.id,
          selectedOptions: [...answer.selectedOptions],
          ...(answer.customInput.trim() ? { customInput: answer.customInput.trim() } : {}),
        };
      }),
    [drafts, request.questions],
  );

  if (!question) return null;

  // An update changes only the fields it names: the other field of the same question keeps its value.
  const updateDraft = (update: Partial<AnswerDraft>) => {
    setDrafts((current) => ({
      ...current,
      [question.id]: { ...emptyDraft(), ...current[question.id], ...update },
    }));
    setError(null);
  };

  const selectOption = (label: string) => {
    if (question.multi) {
      const selected = currentDraft.selectedOptions.includes(label)
        ? currentDraft.selectedOptions.filter((item) => item !== label)
        : [...currentDraft.selectedOptions, label];
      updateDraft({ selectedOptions: selected });
      return;
    }
    updateDraft({ selectedOptions: [label], customInput: "" });
    setOther((current) => ({ ...current, [question.id]: false }));
  };

  // Arrow keys, Home and End move between the options of one question. A single-answer question also takes the
  // option focus reaches, as a radio group does; a checkbox question only moves focus, so Space ticks the box.
  const moveAmongOptions = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-ask-option]"),
    );
    const target = event.target;
    const current = target instanceof HTMLButtonElement ? options.indexOf(target) : -1;
    const next = nextOptionIndex(event.key, current, options.length);
    if (current < 0 || next === undefined) return;
    event.preventDefault();
    options[next]?.focus();
    const label = question.options[next]?.label;
    if (!question.multi && label !== undefined) selectOption(label);
  };

  const setCustomInput = (value: string) => {
    updateDraft({
      customInput: value,
      selectedOptions: question.multi ? currentDraft.selectedOptions : [],
    });
  };

  const moveNext = () => {
    // A checkbox question may be answered with none ticked: its answer is an empty set.
    if (!question.multi && !hasAnswer(currentDraft)) {
      setError("Choose an option or enter an answer before continuing.");
      return;
    }
    setError(null);
    if (questionIndex === request.questions.length - 1) setReview(true);
    else setQuestionIndex((index) => index + 1);
  };

  const submit = async () => {
    const missing = request.questions.find((item) => !item.multi && !hasAnswer(drafts[item.id]));
    if (missing) {
      setReview(false);
      setQuestionIndex(request.questions.indexOf(missing));
      setError("Answer every question before submitting.");
      return;
    }
    setError(null);
    try {
      await context.answer({ kind: "ask", answers });
    } catch {
      setError(ANSWER_NOT_SENT);
    }
  };

  return (
    <DialogFrame
      title={ASK_DIALOG_HEADING}
      description={review ? "Review your answers before submitting." : question.header}
      notice={
        context.deadlineAt === undefined ? undefined : (
          <AskCountdown deadlineAt={context.deadlineAt} />
        )
      }
      actions={
        <>
          <CancelButton onCancel={context.cancel} />
          {review ? (
            <>
              <Button type="button" variant="outline" onClick={() => setReview(false)}>
                Back
              </Button>
              <SubmitButton onClick={() => void submit()}>Submit</SubmitButton>
            </>
          ) : (
            <SubmitButton onClick={moveNext}>
              {questionIndex === request.questions.length - 1 ? "Review" : "Next"}
            </SubmitButton>
          )}
        </>
      }
    >
      {review ? (
        <div className="flex flex-col gap-3 [overflow-wrap:anywhere]" data-testid="ask-review">
          {request.questions.map((item, index) => {
            const answer = answers[index] ?? { selectedOptions: [], customInput: undefined };
            return (
              <div key={item.id} className="rounded-md border border-border p-3">
                <p className="font-medium">{item.question}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {[...answer.selectedOptions, answer.customInput].filter(Boolean).join(", ") ||
                    "None"}
                </p>
              </div>
            );
          })}
          {error ? <ErrorText>{error}</ErrorText> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid={`ask-question-${question.id}`}>
          {request.questions.length > 1 ? (
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Ask questions">
              {request.questions.map((item, index) => (
                <Button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={index === questionIndex}
                  variant={index === questionIndex ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setQuestionIndex(index)}
                >
                  {index + 1}
                </Button>
              ))}
            </div>
          ) : null}
          <fieldset
            className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]"
            role={question.multi ? "group" : "radiogroup"}
            onKeyDown={moveAmongOptions}
          >
            <legend className="mb-1 text-sm">{question.question}</legend>
            <p className="text-xs text-muted-foreground">
              {question.multi ? "Choose any number of options." : "Choose one option."}
            </p>
            {question.options.map((option, index) => {
              const selected = currentDraft.selectedOptions.includes(option.label);
              // A radio group has one tab stop: the chosen option, or the first one while none is chosen.
              const tabStop =
                question.multi ||
                selected ||
                (currentDraft.selectedOptions.length === 0 && index === 0);
              return (
                <Button
                  key={option.label}
                  type="button"
                  size="lg"
                  data-ask-option=""
                  role={question.multi ? "checkbox" : "radio"}
                  aria-checked={selected}
                  tabIndex={tabStop ? 0 : -1}
                  variant={selected ? "secondary" : "outline"}
                  className="h-auto justify-start py-2 text-left whitespace-normal"
                  onClick={() => selectOption(option.label)}
                >
                  <OptionMark multi={question.multi === true} selected={selected} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span>{option.label}</span>
                      {question.recommended === index ? (
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                          Recommended
                        </span>
                      ) : null}
                    </span>
                    {option.description ? (
                      <span className="text-xs font-normal text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </Button>
              );
            })}
          </fieldset>
          <Button
            type="button"
            variant={other[question.id] ? "secondary" : "ghost"}
            className="justify-start"
            onClick={() =>
              setOther((current) => ({ ...current, [question.id]: !current[question.id] }))
            }
          >
            Other
          </Button>
          {other[question.id] ? (
            <Input
              autoFocus
              aria-label="Other answer"
              placeholder="Type your answer"
              value={currentDraft.customInput}
              onChange={(event) => setCustomInput(event.currentTarget.value)}
            />
          ) : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
        </div>
      )}
    </DialogFrame>
  );
}
