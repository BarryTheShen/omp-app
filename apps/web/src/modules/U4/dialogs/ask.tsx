import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AskDialogRequest } from "../contract";
import type { DialogRenderContext } from "../host";
import { CancelButton, DialogFrame, ErrorText, Input, SubmitButton } from "./common";

type AnswerDraft = { selectedOptions: string[]; customInput: string };

function emptyDraft(): AnswerDraft {
  return { selectedOptions: [], customInput: "" };
}

function hasAnswer(answer: AnswerDraft | undefined): boolean {
  return Boolean(
    answer && (answer.selectedOptions.length > 0 || answer.customInput.trim().length > 0),
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

  const updateDraft = (update: Partial<AnswerDraft>) => {
    setDrafts((current) => ({
      ...current,
      [question.id]: { ...current[question.id], ...emptyDraft(), ...update },
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

  const setCustomInput = (value: string) => {
    updateDraft({
      customInput: value,
      selectedOptions: question.multi ? currentDraft.selectedOptions : [],
    });
  };

  const moveNext = () => {
    if (!hasAnswer(currentDraft)) {
      setError("Choose an option or enter an answer before continuing.");
      return;
    }
    setError(null);
    if (questionIndex === request.questions.length - 1) setReview(true);
    else setQuestionIndex((index) => index + 1);
  };

  const submit = async () => {
    const missing = request.questions.find((item) => !hasAnswer(drafts[item.id]));
    if (missing) {
      setReview(false);
      setQuestionIndex(request.questions.indexOf(missing));
      setError("Answer every question before submitting.");
      return;
    }
    await context.answer({ kind: "ask", answers });
  };

  return (
    <DialogFrame
      title="Answer questions"
      description={
        review ? "Review your answers before submitting." : (question.header ?? question.question)
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
        <div className="flex flex-col gap-3" data-testid="ask-review">
          {request.questions.map((item, index) => {
            const answer = answers[index] ?? { selectedOptions: [], customInput: undefined };
            return (
              <div key={item.id} className="rounded-md border border-border p-3">
                <p className="font-medium">{item.question}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {[...answer.selectedOptions, answer.customInput].filter(Boolean).join(", ") ||
                    "No answer"}
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
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm">{question.question}</legend>
            {question.options.map((option) => {
              const selected = currentDraft.selectedOptions.includes(option.label);
              return (
                <Button
                  key={option.label}
                  type="button"
                  role={question.multi ? "checkbox" : "radio"}
                  aria-checked={selected}
                  variant={selected ? "secondary" : "outline"}
                  onClick={() => selectOption(option.label)}
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
