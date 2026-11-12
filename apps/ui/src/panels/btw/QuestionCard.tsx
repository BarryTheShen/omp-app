import type {
  AnswerQuestionParams,
  QuestionAnswer,
  QuestionRecord,
} from "@omp-app/contracts/chat-host";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ChatController } from "../../chat/controller";
import { OmpQuestionCard } from "../../chat/HostRequests";
import { OptionText } from "../../chat/QuestionsDialog";
import { isImeEnter } from "../../keys/ime";
import { PlanCard } from "../../plan/PlanCard";
import { Clamped } from "../../questions/Clamped";
import {
  type Ask,
  answerSummary,
  askSendLabel,
  asksInPanelOrder,
  unsent,
} from "../../questions/questions";
import { useOmpQuestions, usePlan } from "../../questions/waiting";
import { Markdown } from "../../vendor/collab-web/components/transcript/Markdown";

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const TIME = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The radio value of Other…: no choice can have it, as the host refuses empty labels. */
const OTHER = "\u0000other";

/** A choice's row, all of it its target: on a phone 44 px for one line, the mark beside its first line. */
const CHOICE_ROW = "flex items-start gap-2.5 max-sm:py-[13px]";

/** A question's name: its header, else its text. */
const nameOf = (record: QuestionRecord): string => record.header ?? record.question;

/** An ask's name for a screen reader: "Question: …" for one question, "Questions: …, …" for several. */
const askName = (ask: Ask): string =>
  `${ask.records.length === 1 ? "Question" : "Questions"}: ${ask.records.map(nameOf).join(", ")}`;

/** What answers a chat's questions: its controller in the chat, or the dashboard's line to that chat. */
export interface QuestionAnswerer {
  answerQuestion(id: string, answer: Omit<AnswerQuestionParams, "id">): Promise<QuestionRecord>;
  skipQuestion(id: string): Promise<QuestionRecord>;
  sendAnswers(): Promise<readonly QuestionRecord[]>;
}

/**
 * What the chat waits for from you, in the Questions panel: the plan omp proposed in plan mode, and omp's questions that
 * stop the chat until you answer (each as above the chat's message box, and answered in either place); each ask of the
 * questions the agent asked without waiting with a question open, as one card to answer when there is time; the asks
 * whose answers wait to go with the rest, with Send answers; then the asks that went to omp, folded to their answers.
 */
export function QuestionsTab({ controller }: { readonly controller: ChatController }): ReactNode {
  const { records } = useSyncExternalStore(
    controller.questions.subscribe,
    controller.questions.getSnapshot,
  );
  const plan = usePlan(controller);
  const omp = useOmpQuestions(controller);
  const ompWaits = plan !== null || omp.length > 0;

  if (records === null && !ompWaits)
    return <p className="px-4 py-3 text-[0.8125rem] text-t3">Reading the questions…</p>;
  const list = records ?? [];
  if (list.length === 0 && !ompWaits)
    return (
      <div className="flex flex-col gap-2 px-4 py-6">
        <p className="font-medium text-t1">No questions for you</p>
        <p className="text-[0.8125rem] text-t3">
          When omp asks you something it does not need at once, the question waits here while omp
          keeps working. Answer when you have time: your answers go to the chat together, as your
          message, once every question here has an answer or a skip, or when you send them. A
          question you skip gets no answer: nothing goes to the chat for it. A plan omp proposes in
          plan mode, and omp's questions that stop the chat until you answer, wait here too.
        </p>
      </div>
    );
  const { open, waiting, answered } = asksInPanelOrder(list);
  const held = list.filter((record) => record.answer?.held === true).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-[0.8125rem]">
      {held > 0 && <WaitingBar controller={controller} count={held} />}
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
      {!ompWaits && open.length === 0 && waiting.length === 0 && (
        <p className="px-1 text-t3">Nothing waits for you. Answered questions are below.</p>
      )}
      {open.map((ask) => (
        <AskCard key={ask.toolCallId} ask={ask} records={list} controller={controller} />
      ))}
      {waiting.length > 0 && (
        <section aria-label="Ready to send" className="flex flex-col gap-1.5">
          <h3 className="px-1 pt-1 text-xs font-medium text-t3">Ready to send</h3>
          {waiting.map((ask) => (
            <WaitingAskCard key={ask.toolCallId} ask={ask} records={list} controller={controller} />
          ))}
        </section>
      )}
      {answered.length > 0 && (
        <section aria-label="Answered questions" className="flex flex-col gap-1.5">
          <h3 className="px-1 pt-1 text-xs font-medium text-t3">Answered</h3>
          {answered.map((ask) => (
            <article
              key={ask.toolCallId}
              data-ask={ask.toolCallId}
              aria-label={`Answered: ${ask.records.map(nameOf).join(", ")}`}
              className="flex flex-col gap-1.5 rounded-lg border border-l2 px-3 py-2"
            >
              {ask.records.map((record) => (
                <FoldedAnswer key={record.id} record={record} />
              ))}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * A chat's questions that wait, outside the chat (the dashboard): each ask with a question open as one card to answer,
 * then the asks whose answers wait to go with the rest, with Send answers; answered ones are not shown.
 */
export function WaitingQuestions({
  records,
  controller,
}: {
  readonly records: readonly QuestionRecord[];
  readonly controller: QuestionAnswerer;
}): ReactNode {
  const { open, waiting } = asksInPanelOrder(records);
  const held = records.filter((record) => record.answer?.held === true).length;
  return (
    <div className="flex flex-col gap-3 text-[0.8125rem]">
      {held > 0 && <WaitingBar controller={controller} count={held} />}
      {open.map((ask) => (
        <AskCard key={ask.toolCallId} ask={ask} records={records} controller={controller} />
      ))}
      {waiting.length > 0 && (
        <section aria-label="Ready to send" className="flex flex-col gap-1.5">
          <h4 className="px-1 pt-1 text-xs font-medium text-t3">Ready to send</h4>
          {waiting.map((ask) => (
            <WaitingAskCard
              key={ask.toolCallId}
              ask={ask}
              records={records}
              controller={controller}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * The answers that wait for the chat's other open questions, and Send answers, which sends them now as one message; the
 * questions not answered stay open.
 */
function WaitingBar({
  controller,
  count,
}: {
  readonly controller: QuestionAnswerer;
  readonly count: number;
}): ReactNode {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sendNow = (): void => {
    if (sending) return;
    setSending(true);
    setProblem(null);
    controller
      .sendAnswers()
      .catch((failure: unknown) => setProblem(`Not sent: ${failureText(failure)}`))
      .finally(() => setSending(false));
  };
  return (
    <section
      aria-label="Answers ready to send"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-l3 bg-l1 px-3 py-2"
    >
      <p className="min-w-0 flex-1 text-t2">
        <span className="font-medium text-t1">
          {count === 1 ? "1 answer ready." : `${count} answers ready.`}
        </span>{" "}
        They go to omp together once every open question has an answer or a skip.
      </p>
      <Button type="button" size="sm" variant="secondary" disabled={sending} onClick={sendNow}>
        {sending ? "Sending…" : "Send answers"}
      </Button>
      {problem !== null && (
        <p role="alert" className="w-full text-xs text-bad-ink">
          {problem}
        </p>
      )}
    </section>
  );
}

/** A question's answer in a few words, as a folded card shows it: the question, the answer or Skipped, the note. */
function FoldedAnswer({ record }: { readonly record: QuestionRecord }): ReactNode {
  const answer = record.answer;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="line-clamp-2 text-t2">{record.question}</span>
      <span className="text-xs text-t3">
        {answer?.skipped === true ? "Skipped" : "Your answer"}
        {answer !== null && answer.held !== true && (
          <span className="font-mono"> · {TIME.format(answer.sentAt ?? answer.answeredAt)}</span>
        )}
      </span>
      {answer !== null && !answer.skipped && (
        <span className="break-words text-t1">{answerSummary(record)}</span>
      )}
      {answer?.note !== undefined && (
        <span className="break-words text-xs text-t3">Note: {answer.note}</span>
      )}
    </span>
  );
}

/** An ask whose answers wait for the chat's other open questions: what they say, and Change, which opens its card. */
function WaitingAskCard({
  ask,
  records,
  controller,
}: {
  readonly ask: Ask;
  readonly records: readonly QuestionRecord[];
  readonly controller: QuestionAnswerer;
}): ReactNode {
  const [changing, setChanging] = useState(false);
  if (changing)
    return (
      <AskCard
        ask={ask}
        records={records}
        controller={controller}
        onClose={() => setChanging(false)}
      />
    );
  return (
    <article
      data-ask={ask.toolCallId}
      aria-label={`Ready to send: ${ask.records.map(nameOf).join(", ")}`}
      className="flex items-start gap-2 rounded-lg border border-l3 py-2 pr-1.5 pl-3"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        {ask.records.map((record) => (
          <FoldedAnswer key={record.id} record={record} />
        ))}
      </span>
      <Button type="button" size="sm" variant="ghost" onClick={() => setChanging(true)}>
        Change
      </Button>
    </article>
  );
}

/** One question's answer as the card holds it before it goes: the choices, the written answer, the note, or a skip. */
interface Draft {
  readonly picked: readonly string[];
  /** The written answer: Other…'s, or the whole answer when there are no choices; undefined while Other… is off. */
  readonly typed: string | undefined;
  readonly note: string | undefined;
  readonly skipped: boolean;
}

/** Where a question's answer starts: its waiting answer, else the recommended choice already picked. */
function draftOf(record: QuestionRecord, held: QuestionAnswer | null): Draft {
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
const decided = (draft: Draft): boolean =>
  draft.skipped || draft.picked.length > 0 || (draft.typed ?? "").trim() !== "";

/**
 * One ask to answer, all its questions in one card in the order asked: each under its header with the agent's context,
 * its choices (the recommended one already picked; round marks for one, tick boxes for several) with Other… to write
 * one's own, or a box to write the answer in when there are no choices; a note may go with each; and Skip on each, which
 * leaves it unanswered (nothing goes to the chat for it). A question that already went to omp shows its answer. The one
 * button at the foot saves the card's answers to wait for the chat's other open asks, or, on the chat's last, sends them
 * with the waiting answers as the person's message. Opened again from its waiting answers (`onClose`), it has Cancel.
 */
function AskCard({
  ask,
  records,
  controller,
  onClose,
}: {
  readonly ask: Ask;
  readonly records: readonly QuestionRecord[];
  readonly controller: QuestionAnswerer;
  readonly onClose?: () => void;
}): ReactNode {
  const card = useRef<HTMLElement>(null);
  // Opened again from its waiting answers, at the foot of the list: brought into view.
  useEffect(() => {
    if (onClose !== undefined) card.current?.scrollIntoView({ block: "nearest" });
  }, [onClose]);
  const toSend = unsent(ask);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(
    () =>
      new Map(
        toSend.map((record) => [
          record.id,
          draftOf(record, record.answer?.held === true ? record.answer : null),
        ]),
      ),
  );
  const [sending, setSending] = useState(false);
  const sendButton = useRef<HTMLButtonElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const draft = (record: QuestionRecord): Draft =>
    drafts.get(record.id) ?? draftOf(record, record.answer?.held === true ? record.answer : null);
  const ready = toSend.length > 0 && toSend.every((record) => decided(draft(record)));
  const label = askSendLabel(ask, records);

  const send = (): void => {
    if (!ready || sending) return;
    setSending(true);
    setProblem(null);
    void (async () => {
      try {
        // In the order asked: the chat's last answer sends them all, as one message.
        for (const record of toSend) {
          const { picked, typed, note, skipped } = draft(record);
          if (skipped) {
            await controller.skipQuestion(record.id);
            continue;
          }
          const written = typed?.trim();
          const noted = note?.trim();
          await controller.answerQuestion(record.id, {
            picked: [...picked],
            ...(written ? { typed: written } : {}),
            ...(noted ? { note: noted } : {}),
          });
        }
        onClose?.();
      } catch (failure) {
        setProblem(
          `${label.startsWith("Save") ? "Not saved" : "Not sent"}: ${failureText(failure)}`,
        );
      } finally {
        setSending(false);
      }
    })();
  };
  /**
   * Enter in a written answer finishes that answer and moves on: to the next question's choice or box, or after the last
   * to the button that sends, never sending by itself. The other questions already have the recommended choice picked,
   * so an Enter that sent would answer them before the person got to them. Shift+Enter starts a line.
   */
  const enterMoves = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (isImeEnter(event)) return;
    event.preventDefault();
    const here = event.currentTarget.closest<HTMLElement>("section[data-id]");
    const questions = [
      ...(here?.parentElement?.querySelectorAll<HTMLElement>(":scope > section[data-id]") ?? []),
    ];
    for (const next of questions.slice(questions.indexOf(here as HTMLElement) + 1)) {
      // Its picked round mark, else its first round mark, tick box or box: never Skip, which Enter would press.
      const control =
        next.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
        next.querySelector<HTMLElement>('[role="radio"], [role="checkbox"], textarea');
      if (control !== null) {
        control.focus();
        return;
      }
    }
    sendButton.current?.focus();
  };
  /** Ctrl+Enter (⌘+Enter on a Mac) anywhere in the card sends it, as the button does. */
  const sendKeys = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || isImeEnter(event)) return;
    event.preventDefault();
    send();
  };

  const [wide, setWide] = useState(false);
  /** The card's inside: inline in the panel (`clamp`: long text shows its start), or wide over the app. */
  const inside = (clamp: boolean): ReactNode => (
    <>
      <header className="flex items-center gap-2 text-xs text-t3">
        <span className="font-mono">Asked {TIME.format(ask.records[0]?.askedAt ?? 0)}</span>
        {ask.records.length > 1 && <span>· {ask.records.length} questions</span>}
      </header>
      {ask.records.map((record) =>
        record.answer !== null && record.answer.held !== true ? (
          <section
            key={record.id}
            data-id={record.id}
            aria-label={`Question: ${nameOf(record)}`}
            className="flex flex-col gap-1 border-l2 border-t pt-2.5 first-of-type:border-t-0 first-of-type:pt-0"
          >
            <FoldedAnswer record={record} />
          </section>
        ) : (
          <QuestionFields
            key={record.id}
            record={record}
            draft={draft(record)}
            onChange={(next) => setDrafts((now) => new Map(now).set(record.id, next))}
            onEnter={enterMoves}
            onReadAll={clamp ? () => setWide(true) : undefined}
          />
        ),
      )}
      {problem !== null && (
        <p role="alert" className="text-xs text-bad-ink">
          {problem}
        </p>
      )}
      <footer className="flex flex-wrap items-center justify-end gap-2">
        {onClose !== undefined && (
          <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={onClose}>
            Cancel
          </Button>
        )}
        <Button
          ref={sendButton}
          type="button"
          size="sm"
          disabled={!ready || sending}
          onClick={send}
        >
          {sending ? (label.startsWith("Save") ? "Saving…" : "Sending…") : label}
        </Button>
      </footer>
    </>
  );

  return (
    <article
      ref={card}
      data-ask={ask.toolCallId}
      aria-label={askName(ask)}
      onKeyDown={sendKeys}
      className="flex flex-col gap-3 rounded-xl border border-l3 bg-card p-3 shadow-sm"
    >
      {wide ? (
        <>
          <p className="text-xs text-t3">Open in full over the app.</p>
          {/* Read all: the same card, its answers kept, wide over the app (the whole screen on a phone), its text at
              the normal size and its tables at full width; closing it brings the card back here. */}
          <Dialog open onOpenChange={(open) => (open ? undefined : setWide(false))}>
            <DialogContent className="max-sm:h-[calc(100dvh-var(--safe-top)-var(--safe-bottom)-1rem)] flex flex-col gap-3 overflow-y-auto sm:max-w-3xl">
              <DialogTitle className="sr-only">{askName(ask)}</DialogTitle>
              <div className="flex flex-col gap-3 pr-6">{inside(false)}</div>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        inside(true)
      )}
    </article>
  );
}

/**
 * One question of a card: its header and Skip, the question, the agent's context, then the answer: choices with Other…,
 * or a box to write in; and a note. A skipped question shows only that it is skipped, with Answer to take it back. In
 * the panel (`onReadAll`), a question longer than about 12 lines, or one with a table, shows its start and Read all.
 */
function QuestionFields({
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
