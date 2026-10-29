import type {
  ApproveAnswer,
  ApproveDialog,
  AskDialog,
  HostDialogAnswer,
  HostDialogRequest,
} from "@omp-app/contracts/chat-host";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ChatController } from "./controller";

type Answer = (answer: HostDialogAnswer) => void;

/**
 * What omp waits on, above the message box: the oldest open dialog (a tool approval, questions, a choice, a text), one
 * at a time; the count of the others shows under it.
 */
export function HostRequests({
  controller,
  requests,
}: {
  readonly controller: ChatController;
  readonly requests: readonly HostDialogRequest[];
}): ReactNode {
  const request = requests[0];
  if (request === undefined) return null;
  return (
    <div className="px-4 pt-2">
      <div className="mx-auto max-w-[720px]">
        <RequestCard
          key={request.id}
          controller={controller}
          request={request}
          waiting={requests.length - 1}
        />
      </div>
    </div>
  );
}

function RequestCard({
  controller,
  request,
  waiting,
}: {
  readonly controller: ChatController;
  readonly request: HostDialogRequest;
  readonly waiting: number;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const answer: Answer = (value) => {
    setBusy(true);
    setError(null);
    controller
      .answer(request.id, value)
      .catch((failure: unknown) =>
        setError(`Not sent: ${failure instanceof Error ? failure.message : String(failure)}`),
      )
      .finally(() => setBusy(false));
  };
  let title: string;
  let body: ReactNode;
  switch (request.method) {
    case "ui.approve": {
      title = request.params.prompt.compact.split("\n")[0] ?? "Allow this tool?";
      body = <Approval dialog={request.params} busy={busy} onAnswer={answer} />;
      break;
    }
    case "ui.ask":
      title = "Questions from omp";
      body = <Questions dialog={request.params} busy={busy} onAnswer={answer} />;
      break;
    case "ui.select":
      title = request.params.title;
      body = (
        <Choices
          options={request.params.options}
          details={request.params.optionDetails}
          busy={busy}
          onAnswer={answer}
        />
      );
      break;
    case "ui.confirm":
      title = request.params.title;
      body = (
        <>
          <p className="whitespace-pre-wrap text-t2">{request.params.message}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => answer({ confirmed: true })}>
              Yes
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => answer({ confirmed: false })}
            >
              No
            </Button>
          </div>
        </>
      );
      break;
    case "ui.input":
      title = request.params.title;
      body = (
        <TextAnswer
          initial=""
          placeholder={request.params.placeholder}
          multiline={false}
          busy={busy}
          onAnswer={answer}
        />
      );
      break;
    case "ui.editor":
      title = request.params.title;
      body = (
        <TextAnswer
          initial={request.params.prefill ?? ""}
          multiline
          busy={busy}
          onAnswer={answer}
        />
      );
      break;
  }
  return (
    <section
      role="dialog"
      aria-label={title}
      className="flex flex-col gap-3 rounded-xl border border-l3 bg-card p-3.5 shadow-md"
    >
      <p className="font-medium text-t1">{title}</p>
      {body}
      {error !== null && <p className="text-xs text-bad-ink">{error}</p>}
      {waiting > 0 && (
        <p className="text-xs text-t3">
          {waiting === 1 ? "1 more is waiting." : `${waiting} more are waiting.`}
        </p>
      )}
    </section>
  );
}

/** omp's tool approval, with omp's own choices in omp's order (`tools/approval.ts`, `approvalChoiceLabels`). */
function Approval({
  dialog,
  busy,
  onAnswer,
}: {
  readonly dialog: ApproveDialog;
  readonly busy: boolean;
  readonly onAnswer: Answer;
}): ReactNode {
  const { prompt } = dialog;
  const [full, setFull] = useState(false);
  const details = (full ? prompt.full : prompt.compact).split("\n").slice(1).join("\n").trim();
  const grants = prompt.grants ?? [];
  const choices: readonly { label: string; answer: ApproveAnswer }[] = [
    ...grants.map((grant) => ({
      label: grant.label,
      answer: { grant: grant.scope, always: false } as const,
    })),
    ...grants.map((grant) => ({
      label: grant.alwaysLabel,
      answer: { grant: grant.scope, always: true } as const,
    })),
    { label: grants.length > 0 ? "Approve Once" : "Approve", answer: "once" },
    ...(prompt.session === undefined
      ? []
      : [{ label: prompt.session, answer: "session" as const }]),
    { label: "Deny", answer: "deny" },
  ];
  return (
    <>
      {details !== "" && (
        <pre className="max-h-56 overflow-auto rounded-lg bg-(--code-bg) p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-t2">
          {details}
        </pre>
      )}
      {prompt.full !== prompt.compact && (
        <Button variant="link" size="xs" className="self-start px-0" onClick={() => setFull(!full)}>
          {full ? "Show less" : "Show everything omp sent"}
        </Button>
      )}
      <fieldset className="flex min-w-0 flex-wrap gap-2">
        <legend className="sr-only">Choices</legend>
        {choices.map((choice) => (
          <Button
            key={choice.label}
            size="sm"
            variant={
              choice.answer === "once"
                ? "default"
                : choice.answer === "deny"
                  ? "outline"
                  : "secondary"
            }
            disabled={busy}
            onClick={() => onAnswer(choice.answer)}
          >
            {choice.label}
          </Button>
        ))}
      </fieldset>
      <p className="text-xs text-t3">
        From the message box: <Keycap>Ctrl</Keycap> <Keycap>Enter</Keycap>{" "}
        {grants.length > 0 ? "approves once" : "approves"}, <Keycap>Esc</Keycap> denies.
      </p>
    </>
  );
}

function Keycap({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <kbd className="rounded-sm border border-l2 px-1 font-mono text-[11px] text-t2">{children}</kbd>
  );
}

/** omp's `ask`: every question with its options (one or several), the recommended one marked, and a typed answer. */
function Questions({
  dialog,
  busy,
  onAnswer,
}: {
  readonly dialog: AskDialog;
  readonly busy: boolean;
  readonly onAnswer: Answer;
}): ReactNode {
  const { questions } = dialog;
  const [picked, setPicked] = useState<readonly (readonly string[])[]>(() =>
    questions.map(() => []),
  );
  const [typed, setTyped] = useState<readonly string[]>(() => questions.map(() => ""));
  const answered = (index: number): boolean =>
    (picked[index]?.length ?? 0) > 0 || (typed[index] ?? "").trim() !== "";
  const pick = (index: number, next: readonly string[]): void =>
    setPicked(picked.map((current, at) => (at === index ? next : current)));
  const submit = (): void =>
    onAnswer({
      answers: questions.map((question, index) => {
        const text = (typed[index] ?? "").trim();
        return {
          id: question.id,
          selectedOptions: [...(picked[index] ?? [])],
          ...(text === "" ? {} : { customInput: text }),
        };
      }),
    });
  return (
    <>
      {questions.map((question, index) => {
        const chosen = picked[index] ?? [];
        return (
          <fieldset key={question.id} className="flex flex-col gap-2">
            <legend className="mb-2 text-t1">
              {question.header !== undefined && (
                <span className="mr-2 text-xs text-t3">{question.header}</span>
              )}
              {question.question}
            </legend>
            {question.multi === true ? (
              question.options.map((option, at) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
                <label key={option.label} className="flex items-start gap-2.5">
                  <Checkbox
                    className="mt-0.5"
                    aria-label={option.label}
                    checked={chosen.includes(option.label)}
                    onCheckedChange={(checked) =>
                      pick(
                        index,
                        checked
                          ? [...chosen, option.label]
                          : chosen.filter((label) => label !== option.label),
                      )
                    }
                  />
                  <OptionText
                    label={option.label}
                    description={option.description}
                    recommended={question.recommended === at}
                  />
                </label>
              ))
            ) : (
              <RadioGroup
                value={chosen[0] ?? null}
                onValueChange={(value) => pick(index, typeof value === "string" ? [value] : [])}
              >
                {question.options.map((option, at) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: the radio inside is the control
                  <label key={option.label} className="flex items-start gap-2.5">
                    <RadioGroupItem
                      className="mt-0.5"
                      value={option.label}
                      aria-label={option.label}
                    />
                    <OptionText
                      label={option.label}
                      description={option.description}
                      recommended={question.recommended === at}
                    />
                  </label>
                ))}
              </RadioGroup>
            )}
            <Input
              aria-label={`Your own answer: ${question.question}`}
              placeholder="Or type your own answer"
              value={typed[index] ?? ""}
              onChange={(event) =>
                setTyped(typed.map((current, at) => (at === index ? event.target.value : current)))
              }
            />
          </fieldset>
        );
      })}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !questions.every((_, index) => answered(index))}
          onClick={submit}
        >
          Send answers
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => onAnswer({ cancelled: true })}
        >
          Skip
        </Button>
      </div>
    </>
  );
}

function OptionText({
  label,
  description,
  recommended,
}: {
  readonly label: string;
  readonly description: string | undefined;
  readonly recommended: boolean;
}): ReactNode {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="break-words text-t1">
        {label}
        {recommended && (
          <span className="ml-2 rounded-sm bg-l2 px-1.5 py-0.5 text-[11px] text-accent-ink">
            Recommended
          </span>
        )}
      </span>
      {description !== undefined && (
        <span className="break-words text-xs text-t3">{description}</span>
      )}
    </span>
  );
}

/** A plain choice among omp's options. */
function Choices({
  options,
  details,
  busy,
  onAnswer,
}: {
  readonly options: readonly string[];
  readonly details: readonly { readonly description?: string }[] | undefined;
  readonly busy: boolean;
  readonly onAnswer: Answer;
}): ReactNode {
  return (
    <>
      <div className="flex flex-col gap-1">
        {options.map((option, index) => (
          <Button
            // biome-ignore lint/suspicious/noArrayIndexKey: omp's options can repeat a label; their order is their identity
            key={index}
            variant="ghost"
            className="h-auto justify-start py-1.5 text-left whitespace-normal"
            disabled={busy}
            onClick={() => onAnswer({ value: option })}
          >
            <OptionText
              label={option}
              description={details?.[index]?.description}
              recommended={false}
            />
          </Button>
        ))}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        disabled={busy}
        onClick={() => onAnswer({ cancelled: true })}
      >
        Cancel
      </Button>
    </>
  );
}

/** A text omp asks for: one line, or a longer text in an editor, filled with omp's draft. */
function TextAnswer({
  initial,
  placeholder,
  multiline,
  busy,
  onAnswer,
}: {
  readonly initial: string;
  readonly placeholder?: string | undefined;
  readonly multiline: boolean;
  readonly busy: boolean;
  readonly onAnswer: Answer;
}): ReactNode {
  const [text, setText] = useState(initial);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ value: text });
      }}
    >
      {multiline ? (
        <Textarea
          aria-label="Your answer"
          className="max-h-72 min-h-24"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      ) : (
        <Input
          aria-label="Your answer"
          placeholder={placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          Send
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => onAnswer({ cancelled: true })}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
