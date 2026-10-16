import { type KeyboardEvent, useId, useRef } from "react";
import { InlineError, ListRow, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/modules/P1/panels/model";
import { MarkdownContent } from "@/modules/U1/markdown/markdown-content";
import type {
  PanelActionAvailability,
  PanelFocusToken,
  PanelOpenReason,
} from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import {
  BTW_STATUS_LABEL,
  type BtwPanelModel,
  type CleansePanelModel,
  type OmfgPanelModel,
  type PausePanelModel,
  panelStateOf,
} from "./model";

interface CommonPanelProps {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean, reason: PanelOpenReason) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly className?: string;
}

function ActionButton({
  title,
  action,
  onSelect,
}: {
  readonly title: string;
  readonly action: PanelActionAvailability;
  readonly onSelect: () => void;
}) {
  const reasonId = useId();
  const reason = action.state === "unavailable" ? action.reason : undefined;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        aria-describedby={reason ? reasonId : undefined}
        disabled={reason !== undefined}
        onClick={onSelect}
        type="button"
        variant="outline"
      >
        {title}
      </Button>
      {reason ? (
        <p
          className="max-w-56 text-xs text-muted-foreground [overflow-wrap:anywhere]"
          id={reasonId}
        >
          {reason}
        </p>
      ) : null}
    </div>
  );
}

export interface BtwPanelProps extends CommonPanelProps {
  readonly model: BtwPanelModel;
  readonly onSelect: (id: string) => void;
  readonly onCopy: () => void;
  readonly onCancel: () => void;
  readonly onBranch: () => void;
}

function BtwPanel({ model, onSelect, onCopy, onCancel, onBranch, ...props }: BtwPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selected = model.turns.find((turn) => turn.id === model.selectedId);
  const showsBody = model.lifecycle !== "empty" && model.lifecycle !== "unavailable";
  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const nextIndex =
      (index + (event.key === "ArrowDown" ? 1 : -1) + model.turns.length) % model.turns.length;
    const next = model.turns[nextIndex];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(next.id);
    const target = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-focus-key]") ?? [],
    ).find((row) => row.dataset.focusKey === next.id);
    target?.focus();
  };
  return (
    <PanelShell
      {...props}
      body={
        !showsBody ? null : selected === undefined ? (
          <div className="min-w-0" />
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <Section heading="Question history" headingLevel={3} variant="dialog">
              <div
                aria-label="Side question history"
                className="min-w-0"
                ref={listRef}
                role="listbox"
              >
                {model.turns.map((turn, index) => (
                  <ListRow
                    key={turn.id}
                    title={turn.question}
                    titleTooltip={turn.question}
                    trailing={
                      <span className="text-muted-foreground text-xs">
                        {BTW_STATUS_LABEL[turn.status]}
                      </span>
                    }
                    selected={turn.id === model.selectedId}
                    tabIndex={turn.id === model.selectedId ? 0 : -1}
                    focusKey={turn.id}
                    onSelect={() => onSelect(turn.id)}
                    onKeyDown={(event) => moveSelection(event, index)}
                  />
                ))}
              </div>
            </Section>
            <Section
              ariaLabel="Side question answer"
              heading="Answer"
              headingLevel={3}
              variant="dialog"
            >
              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs">Question</span>
                <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{selected.question}</p>
              </div>
              {selected.answer ? (
                <MarkdownContent text={selected.answer} variant="compact" />
              ) : null}
              {selected.status === "running" && selected.answer === "" ? (
                <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
                  Waiting for an answer…
                </p>
              ) : null}
              {selected.error ? <InlineError message={selected.error} /> : null}
            </Section>
          </div>
        )
      }
      footer={
        showsBody && selected ? (
          <Toolbar ariaLabel="Side question actions" alignment="end">
            <ActionButton action={model.copy} onSelect={onCopy} title="Copy answer" />
            <ActionButton action={model.cancel} onSelect={onCancel} title="Cancel question" />
            <ActionButton action={model.branch} onSelect={onBranch} title="Open in chat" />
          </Toolbar>
        ) : undefined
      }
      state={panelStateOf(model, props.open ?? true, "right", true)}
    />
  );
}

export interface CleansePanelProps extends CommonPanelProps {
  readonly model: CleansePanelModel;
  readonly onCheck: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}

function CleansePanel({ model, onCheck, onRun, onCancel, ...props }: CleansePanelProps) {
  const showsBody = model.lifecycle !== "empty" && model.lifecycle !== "unavailable";
  return (
    <PanelShell
      {...props}
      body={
        !showsBody ? null : (
          <div className="flex min-w-0 flex-col gap-3">
            <Section heading="Progress" headingLevel={3} variant="dialog">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Checker</dt>
                  <dd>{model.checker ?? "Not selected"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Wave</dt>
                  <dd>
                    {model.wave === null
                      ? "Not started"
                      : `${model.wave}${model.totalWaves ? ` of ${model.totalWaves}` : ""}`}
                  </dd>
                </div>
              </dl>
              {model.progress !== null ? (
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-xs">
                    <span>Overall progress</span>
                    <span>{Math.round(model.progress * 100)}%</span>
                  </div>
                  <div
                    aria-label="Overall progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(model.progress * 100)}
                    aria-valuetext={`${Math.round(model.progress * 100)}% complete`}
                    className="h-2 w-full overflow-hidden rounded-full bg-foreground/15"
                    role="progressbar"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(model.progress * 100)}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {model.message ? (
                <p className="text-muted-foreground text-sm">{model.message}</p>
              ) : null}
              {model.status === "completed" ? (
                <p aria-live="polite" className="text-sm" role="status">
                  The local cleanse finished.
                </p>
              ) : null}
              {model.status === "cancelled" ? (
                <p aria-live="polite" className="text-sm" role="status">
                  The local cleanse was cancelled.
                </p>
              ) : null}
            </Section>
            {model.agents.length > 0 ? (
              <Section heading="Checker agents" headingLevel={3} variant="plain">
                {model.agents.map((agent) => (
                  <ListRow
                    key={agent.id}
                    asOption={false}
                    title={agent.title}
                    titleTooltip={agent.title}
                    detail={
                      [agent.step, agent.duration].filter(Boolean).join(" · ") ||
                      "Waiting for progress"
                    }
                    trailing={<span className="text-muted-foreground text-xs">{agent.status}</span>}
                  />
                ))}
              </Section>
            ) : null}
          </div>
        )
      }
      footer={
        <Toolbar ariaLabel="Cleanse actions" alignment="end">
          <ActionButton action={model.check} onSelect={onCheck} title="Find checkers" />
          <ActionButton action={model.run} onSelect={onRun} title="Start cleanse" />
          <ActionButton action={model.cancel} onSelect={onCancel} title="Cancel cleanse" />
        </Toolbar>
      }
      state={panelStateOf(model, props.open ?? true)}
    />
  );
}

export interface OmfgPanelProps extends CommonPanelProps {
  readonly model: OmfgPanelModel;
  readonly onSave: () => void;
  readonly onAmend: () => void;
  readonly onCancel: () => void;
}

function OmfgPanel({ model, onSave, onAmend, onCancel, ...props }: OmfgPanelProps) {
  const showsBody = model.lifecycle !== "empty" && model.lifecycle !== "unavailable";
  return (
    <PanelShell
      {...props}
      body={
        !showsBody ? null : (
          <div className="flex min-w-0 flex-col gap-3">
            <Section heading="Complaint" headingLevel={3} variant="dialog">
              <p className="min-w-0 text-sm [overflow-wrap:anywhere]">
                {model.complaint || "No complaint entered."}
              </p>
            </Section>
            {model.candidate ? (
              <Section heading="Rule preview" headingLevel={3} variant="dialog">
                <MarkdownContent text={model.candidate} variant="compact" />
              </Section>
            ) : null}
            {model.validation.length > 0 ? (
              <Section heading="Validation messages" headingLevel={3} variant="plain">
                {model.validation.map((message) => (
                  <ListRow key={message} title={message} asOption={false} />
                ))}
              </Section>
            ) : null}
          </div>
        )
      }
      footer={
        <Toolbar ariaLabel="Rule actions" alignment="end">
          <ActionButton action={model.save} onSelect={onSave} title="Save rule" />
          <ActionButton action={model.amend} onSelect={onAmend} title="Amend rule" />
          <ActionButton action={model.cancel} onSelect={onCancel} title="Cancel draft" />
        </Toolbar>
      }
      state={panelStateOf(model, props.open ?? true)}
    />
  );
}

export interface PausePanelProps extends CommonPanelProps {
  readonly model: PausePanelModel;
  readonly onResume: () => void;
}

function PausePanel({ model, onResume, ...props }: PausePanelProps) {
  return (
    <PanelShell
      {...props}
      body={
        !model.snapshot.open ? null : (
          <div className="flex flex-col gap-3">
            <p className="text-2xl font-semibold" role="timer">
              {formatDuration(model.snapshot.elapsedMs)}
            </p>
          </div>
        )
      }
      footer={
        <Toolbar ariaLabel="Pause actions" alignment="end">
          <ActionButton action={model.resume} onSelect={onResume} title="Resume" />
        </Toolbar>
      }
      state={panelStateOf(model, props.open ?? true)}
    />
  );
}

export const operationsViews = {
  btw: BtwPanel,
  cleanse: CleansePanel,
  omfg: OmfgPanel,
  pause: PausePanel,
} as const;
