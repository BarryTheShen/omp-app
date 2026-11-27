import type { QuestionAnswer, QuestionRecord } from "@omp-app/contracts/chat-host";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ChatController } from "../../chat/controller";
import { OmpQuestionCard } from "../../chat/HostRequests";
import { OptionText } from "../../chat/QuestionsDialog";
import { PlanCard } from "../../plan/PlanCard";
import { Clamped } from "../../questions/Clamped";
import { useOmpQuestions, usePlan } from "../../questions/waiting";
import { Markdown } from "../../vendor/collab-web/components/transcript/Markdown";

/** The radio value of Other…: no choice can have it, as the host refuses empty labels. */
const OTHER = "\u0000other";

/** A choice's row, all of it its target: on a phone 44 px for one line, the mark beside its first line. */
const CHOICE_ROW = "flex items-start gap-2.5 max-sm:py-[13px]";

/** A question's name: its header, else its text. */
const nameOf = (record: QuestionRecord): string => record.header ?? record.question;

/**
 * What stops the chat until you answer, in the Questions panel: the plan omp proposed in plan mode, and omp's questions
 * (each as above the chat's message box, and answered in either place). Questions an agent asks without stopping are
 * in Workbench.
 */
export function QuestionsTab({ controller }: { readonly controller: ChatController }): ReactNode {
  const plan = usePlan(controller);
  const omp = useOmpQuestions(controller);
  if (plan === null && omp.length === 0)
    return (
      <div className="flex flex-col gap-2 px-4 py-6">
        <p className="font-medium text-t1">Nothing stops the chat</p>
        <p className="text-[0.8125rem] text-t3">
          A plan omp proposes in plan mode, and omp's questions that stop the chat until you answer,
          wait here and above the message box. Questions omp asks while it keeps working are in
          Workbench.
        </p>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-[0.8125rem]">
      {plan !== null && <PlanCard controller={controller} proposal={plan} inPanel />}
      {omp.length > 0 && (
        <section aria-label="omp waits for your answer" className="flex flex-col gap-1.5">
          <h3 className="px-1 pt-1 text-xs font-medium text-t3">omp waits for your answer</h3>
          {omp.map((request) => (
            <OmpQuestionCard
              key={request.id}
              request={request}
              answerWith={(answer) => controller.answer(request.id, answer)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** One question's answer as the card holds it before it goes: the choices, the written answer, the note, or a skip. */
export interface Draft {
  readonly picked: readonly string[];
  /** The written answer: Other…'s, or the whole answer when there are no choices; undefined while Other… is off. */
  readonly typed: string | undefined;
  readonly note: string | undefined;
  readonly skipped: boolean;
}

/** Where a question's answer starts: its waiting answer, else the recommended choice already picked. */
export function draftOf(record: QuestionRecord, held: QuestionAnswer | null): Draft {
  const written = record.options.length === 0 ? "" : undefined;
  if (held !== null)
    return {
      picked: held.skipped ? [] : held.picked,
      typed: held.typed ?? written,
      note: held.note,
      skipped: held.skipped,
    };
  const recommended =
    record.recommended === undefined ? undefined : record.options[record.recommended]?.label;
  return {
    picked: recommended === undefined ? [] : [recommended],
    typed: written,
    note: undefined,
    skipped: false,
  };
}

/** A question has what its card needs: a choice, a written answer, or a skip. */
export const decided = (draft: Draft): boolean =>
  draft.skipped || draft.picked.length > 0 || (draft.typed ?? "").trim() !== "";

/**
 * One question of a card: its header and Skip, the question, the agent's context, then the answer: choices with Other…,
 * or a box to write in; and a note. A skipped question shows only that it is skipped, with Answer to take it back. In
 * the panel (`onReadAll`), a question longer than about 12 lines, or one with a table, shows its start and Read all.
 */
export function QuestionFields({
  record,
  draft,
  onChange,
  onEnter,
  onReadAll,
}: {
  readonly record: QuestionRecord;
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
  readonly onEnter: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onReadAll?: () => void;
}): ReactNode {
  const writtenId = useId();
  const choices = record.options.length > 0;
  const { picked, typed, note, skipped } = draft;
  const otherOn = typed !== undefined;
  const clamp = onReadAll !== undefined;
  const otherRow = (
    <span className="flex min-w-0 flex-col">
      <span className="text-t1">Other…</span>
      <span className="text-xs text-t3">Write your own answer</span>
    </span>
  );
  return (
    <section
      data-id={record.id}
      aria-label={`Question: ${nameOf(record)}`}
      className="flex flex-col gap-2.5 border-l2 border-t pt-2.5 first-of-type:border-t-0 first-of-type:pt-0"
    >
      <div className="flex items-center gap-2">
        {record.header !== undefined && (
          <span className="rounded-sm bg-l2 px-1.5 py-0.5 text-xs text-accent-ink">
            {record.header}
          </span>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={skipped}
          onClick={() => onChange({ ...draft, skipped: !skipped })}
        >
          {skipped ? "Answer" : "Skip"}
        </Button>
      </div>
      <Clamped
        clamp={clamp}
        onReadAll={onReadAll ?? (() => undefined)}
        className={skipped ? "text-t3" : "text-t1"}
      >
        <Markdown text={record.question} />
      </Clamped>
      {skipped ? (
        <p className="text-xs text-t3">Skipped: nothing goes to omp for it.</p>
      ) : (
        <>
          {record.context !== undefined && (
            <section
              aria-label="Context"
              className="rounded-lg border border-l2 bg-l1 px-3 py-2 text-xs text-t2"
            >
              <Markdown text={record.context} />
            </section>
          )}
          {!choices ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={writtenId} className="text-xs font-medium text-t2">
                Your answer
              </label>
              <Textarea
                id={writtenId}
                rows={2}
                value={typed ?? ""}
                placeholder="Write your answer"
                onChange={(event) => onChange({ ...draft, typed: event.target.value })}
                onKeyDown={onEnter}
              />
            </div>
          ) : record.multi ? (
            <fieldset
              className="flex min-w-0 flex-col gap-2 max-sm:gap-0"
              aria-label={record.question}
            >
              {record.options.map((option, at) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control
                <label key={option.label} className={CHOICE_ROW}>
                  <Checkbox
                    className="mt-0.5"
                    aria-label={option.label}
                    checked={picked.includes(option.label)}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...draft,
                        picked:
                          checked === true
                            ? [...picked, option.label]
                            : picked.filter((label) => label !== option.label),
                      })
                    }
                  />
                  <OptionText
                    label={option.label}
                    description={option.description}
                    recommended={record.recommended === at}
                  />
                </label>
              ))}
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the tick box inside is the control */}
              <label className={CHOICE_ROW}>
                <Checkbox
                  className="mt-0.5"
                  aria-label="Other…"
                  checked={otherOn}
                  onCheckedChange={(checked) =>
                    onChange({ ...draft, typed: checked === true ? "" : undefined })
                  }
                />
                {otherRow}
              </label>
            </fieldset>
          ) : (
            <RadioGroup
              className="max-sm:gap-0"
              aria-label={record.question}
              value={otherOn ? OTHER : (picked[0] ?? null)}
              onValueChange={(value) => {
                if (value === OTHER) onChange({ ...draft, picked: [], typed: "" });
                else if (typeof value === "string")
                  onChange({ ...draft, picked: [value], typed: undefined });
              }}
            >
              {record.options.map((option, at) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
                <label key={option.label} className={CHOICE_ROW}>
                  <RadioGroupItem
                    className="mt-0.5"
                    value={option.label}
                    aria-label={option.label}
                  />
                  <OptionText
                    label={option.label}
                    description={option.description}
                    recommended={record.recommended === at}
                  />
                </label>
              ))}
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
              <label className={CHOICE_ROW}>
                <RadioGroupItem className="mt-0.5" value={OTHER} aria-label="Other…" />
                {otherRow}
              </label>
            </RadioGroup>
          )}
          {choices && otherOn && (
            // Several lines, as the written answer above: Enter moves on, Shift+Enter starts a line, Ctrl+Enter sends.
            <Textarea
              aria-label={`Your own answer: ${record.question}`}
              rows={2}
              placeholder="Write your own answer"
              value={typed ?? ""}
              onChange={(event) => onChange({ ...draft, typed: event.target.value })}
              onKeyDown={onEnter}
            />
          )}
          {note === undefined ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => onChange({ ...draft, note: "" })}
            >
              Add a note
            </Button>
          ) : (
            <Textarea
              aria-label="Note on your answer"
              placeholder="A note omp gets with your answer"
              className="min-h-16"
              value={note}
              onChange={(event) => onChange({ ...draft, note: event.target.value })}
            />
          )}
        </>
      )}
    </section>
  );
}
