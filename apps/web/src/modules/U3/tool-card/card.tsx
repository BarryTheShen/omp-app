import { cn } from "cn";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranscriptDisplayPolicy } from "@/modules/U1/policy/policy";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Icons } from "../../../tokens";
import type { OutputMeta, ToolCardPhase, ToolCardState } from "./contract";
import { OutputCutNote, outputCutOf, useFullOutputFocus } from "./full-output";
import type { CopyKind, CopySlot } from "./slots";

const MAX_REMEMBERED_DISCLOSURES = 256;
const MAX_PREVIEW_LINES = 12;
const MAX_PREVIEW_CHARACTERS = 8_000;

const rememberedDisclosure = new Map<string, boolean>();

type VisualState = {
  readonly label: string;
  readonly tone: "info" | "success" | "warning" | "danger" | "muted";
  readonly icon: typeof Icons.info;
};

const VISUAL_BY_PHASE: Record<ToolCardPhase, VisualState> = {
  running: { label: "Running", tone: "info", icon: Icons.loading },
  partial: { label: "Streaming", tone: "info", icon: Icons.loading },
  success: { label: "Complete", tone: "success", icon: Icons.success },
  error: { label: "Error", tone: "danger", icon: Icons.error },
  cancelled: { label: "Cancelled", tone: "muted", icon: Icons.warning },
  unrecorded: { label: "Finished", tone: "muted", icon: Icons.info },
};

/** A call omp has not started yet (ToolCardState.queued): its run is active, and it waits for its turn. */
const QUEUED_VISUAL: VisualState = { label: "Waiting", tone: "muted", icon: Icons.loading };

const TONE_CLASSES: Record<VisualState["tone"], string> = {
  info: "border-info/30 bg-info-surface text-info-surface-foreground",
  success: "border-success/30 bg-success-surface text-success-surface-foreground",
  warning: "border-warning/30 bg-warning-surface text-warning-surface-foreground",
  danger: "border-danger/30 bg-danger-surface text-danger-surface-foreground",
  muted: "border-border bg-muted text-muted-foreground",
};

/** What the call's work came to, for its chip: the words to show, in the colours of the phase they stand for. */
export interface ToolCardOutcome {
  readonly label: string;
  readonly phase: ToolCardPhase;
}

export interface ToolCardProps {
  readonly state: ToolCardState;
  readonly summary?: string;
  readonly summaryClassName?: string;
  readonly rawResult?: string;
  readonly copySlot?: CopySlot;
  readonly onCopy?: (raw: string, kind: CopyKind) => void | Promise<void>;
  readonly onShowMore?: (state: ToolCardState) => void | Promise<void>;
  readonly className?: string;
  /** What the call's work came to: the chip shows its label in its phase's colours (a task whose job failed). */
  readonly outcome?: ToolCardOutcome;
  /** The card's body: it sits inside the disclosure, so collapsing the card hides it. */
  readonly children?: ReactNode;
}

export function ToolCard({
  state,
  summary: suppliedSummary,
  summaryClassName,
  outcome,
  rawResult,
  copySlot,
  onCopy,
  onShowMore,
  className,
  children,
}: ToolCardProps) {
  const contentId = useId();
  const visual = state.queued === true ? QUEUED_VISUAL : VISUAL_BY_PHASE[state.phase];
  const shown =
    outcome === undefined ? visual : { ...VISUAL_BY_PHASE[outcome.phase], label: outcome.label };
  const status = state.timedOut
    ? { ...shown, label: "Timed out", tone: "warning" as const }
    : shown;
  const remembered = rememberedDisclosure.get(state.toolCallId);
  const policy = useTranscriptDisplayPolicy();
  // Every call starts as one line, running or finished: no call opens or folds by itself. A click or Enter on the
  // line is remembered for its call, and the chat's expand-all flag opens or closes every card.
  const [open, setOpen] = useState(remembered ?? policy.expandTools);
  const [expandedOutput, setExpandedOutput] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "copiedShown" | "failed">(
    "idle",
  );
  const [shownCallId, setShownCallId] = useState(state.toolCallId);
  const [shownFlag, setShownFlag] = useState(policy.expandTools);
  // A card reused for another call starts that call from its own remembered choice, not the last call's.
  if (shownCallId !== state.toolCallId) {
    setShownCallId(state.toolCallId);
    setOpen(remembered ?? policy.expandTools);
    setExpandedOutput(false);
    setCopyStatus("idle");
  }
  // A flip of the chat's flag opens or closes every card, so it clears every remembered choice, not only this card's.
  if (shownFlag !== policy.expandTools) {
    setShownFlag(policy.expandTools);
    rememberedDisclosure.clear();
    setOpen(policy.expandTools);
  }

  const argsRaw = state.argsText;
  const resultRaw = rawResult ?? formatRaw(state.result ?? state.partialResult);
  const cut = outputCutOf(state.result ?? state.partialResult);
  const contentRef = useRef<HTMLDivElement>(null);
  const full = useFullOutputFocus(cut, contentRef, "[data-u3-show-all]");
  const outputExpanded = expandedOutput || policy.expandTools;
  const output = previewOutput(resultRaw, state.outputMeta, outputExpanded);
  // A call with no result says so in the card's own words, whatever summary its family gave: that summary describes a
  // result there is none of, and it must not keep a success look.
  const isUnrecorded = state.phase === "unrecorded";
  const summary = isUnrecorded ? summarize(state) : (suppliedSummary ?? summarize(state));
  const summaryTone = isUnrecorded ? undefined : summaryClassName;

  const rememberOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    rememberedDisclosure.delete(state.toolCallId);
    rememberedDisclosure.set(state.toolCallId, nextOpen);
    while (rememberedDisclosure.size > MAX_REMEMBERED_DISCLOSURES) {
      const oldest = rememberedDisclosure.keys().next().value;
      if (oldest === undefined) break;
      rememberedDisclosure.delete(oldest);
    }
  };

  const copy = async (raw: string, kind: CopyKind) => {
    try {
      if (onCopy !== undefined) {
        await onCopy(raw, kind);
      } else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(raw);
      }
      setCopyStatus(kind === "result" && cut !== undefined ? "copiedShown" : "copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  const showMore = async () => {
    setExpandedOutput(true);
    await onShowMore?.(state);
  };

  if (policy.tools === "hidden") return null;
  const Icon = status.icon;
  return (
    <Collapsible
      className={cn("group/tool-card w-full min-w-0", className)}
      data-phase={state.phase}
      data-queued={state.queued === true ? "true" : undefined}
      data-slot="u3-tool-card"
      data-testid={`tool-card-${state.toolCallId}`}
      open={open}
      onOpenChange={rememberOpen}
    >
      <CollapsibleTrigger
        aria-controls={contentId}
        aria-expanded={open}
        aria-label={`${state.label}: ${status.label}`}
        className="group/tool-card-trigger flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm outline-none transition-colors hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50"
        data-slot="u3-tool-card-trigger"
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            status.tone === "info" && "animate-spin motion-reduce:animate-none",
          )}
          data-slot="u3-tool-card-icon"
        />
        <span className="min-w-0 truncate font-medium text-foreground">{state.label}</span>
        <span
          className={cn(
            "min-w-0 flex-1 text-xs",
            // A call with no result says so in full, so its one line wraps rather than being cut off.
            state.phase === "unrecorded" ? "break-words" : "truncate",
            summaryTone ?? "text-muted-foreground",
          )}
          title={summary}
        >
          {summary}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem] font-medium leading-tight",
            TONE_CLASSES[status.tone],
          )}
          data-slot="u3-tool-card-status"
          data-testid={`tool-state-chip-${state.phase}`}
        >
          {status.label}
        </span>
        <Icons.chevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className="-mx-1 grid grid-rows-[1fr] px-1 transition-[grid-template-rows] duration-(--duration-base) ease-(--ease-standard) group-data-[instant-toggle]/tool-card:transition-none data-[ending-style]:grid-rows-[0fr] data-[starting-style]:grid-rows-[0fr] motion-reduce:transition-none"
        id={contentId}
        data-slot="u3-tool-card-content"
        ref={contentRef}
      >
        <div className="-mx-1 min-h-0 overflow-hidden px-1">
          <div className="border-border/70 ms-2 flex min-w-0 flex-col gap-3 border-s-2 py-2 ps-4">
            {state.error !== undefined && (
              <div
                aria-live="assertive"
                className={cn(
                  "rounded-lg border p-3 text-sm",
                  state.timedOut ? TONE_CLASSES.warning : TONE_CLASSES.danger,
                )}
                data-slot="u3-tool-card-error"
                role="alert"
              >
                <p className="font-medium">{state.error.message}</p>
                {state.error.retryable && <p className="mt-1 text-xs">Retry is available.</p>}
              </div>
            )}
            {children}
            {state.phase === "partial" && resultRaw !== "" && (
              <ToolRawBlock
                copySlot={copySlot}
                kind="result"
                onCopy={copy}
                raw={output.text}
                title="Output so far"
              />
            )}
            <details className="min-w-0 text-xs" data-slot="u3-tool-card-raw">
              <summary className="cursor-pointer text-muted-foreground">Raw details</summary>
              <div className="mt-2 flex min-w-0 flex-col gap-3">
                <ToolRawBlock
                  copySlot={copySlot}
                  kind="args"
                  onCopy={copy}
                  raw={argsRaw}
                  title="Arguments"
                />
                {state.phase !== "partial" && resultRaw !== "" && (
                  <ToolRawBlock
                    copySlot={copySlot}
                    kind="result"
                    onCopy={copy}
                    raw={output.text}
                    title="Result"
                  />
                )}
              </div>
              {output.truncated && (
                <div
                  className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  data-slot="u3-tool-card-truncation"
                >
                  <span>{truncationLabel(state.outputMeta)}</span>
                  {!outputExpanded && (
                    <Button
                      size="xs"
                      type="button"
                      variant="outline"
                      onClick={() => void showMore()}
                    >
                      Show more
                    </Button>
                  )}
                </div>
              )}
            </details>
            {cut !== undefined && (
              <OutputCutNote cut={cut} onLoaded={full.onLoaded} toolCallId={state.toolCallId} />
            )}
            {full.loaded && (
              <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
                Full output loaded
              </span>
            )}
            {copyStatus !== "idle" && (
              <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
                {copyStatusText(copyStatus)}
              </span>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function copyStatusText(status: "copied" | "copiedShown" | "failed"): string {
  switch (status) {
    case "copied":
      return "Copied raw output";
    case "copiedShown":
      return "Copied the shown part of the output. Load the full output to copy all of it.";
    case "failed":
      return "Copy unavailable";
  }
}

function ToolRawBlock({
  raw,
  title,
  kind,
  copySlot,
  onCopy,
}: {
  readonly raw: string;
  readonly title: string;
  readonly kind: CopyKind;
  readonly copySlot?: CopySlot;
  readonly onCopy: (raw: string, kind: CopyKind) => Promise<void>;
}) {
  return (
    <section className="min-w-0" data-slot={`u3-tool-card-${kind}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {copySlot !== undefined ? (
          copySlot({ raw, kind, onCopy: () => onCopy(raw, kind) })
        ) : (
          <Button
            aria-label={`Copy raw ${kind}`}
            className="text-muted-foreground"
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={() => void onCopy(raw, kind)}
          >
            <Icons.copy aria-hidden="true" />
          </Button>
        )}
      </div>
      <pre className="border-border bg-muted/40 text-foreground max-h-80 min-w-0 overflow-auto rounded-lg border p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {raw}
      </pre>
    </section>
  );
}

function summarize(state: ToolCardState): string {
  if (state.error !== undefined) return oneLine(state.error.message);
  if (state.phase === "cancelled") return "Tool call cancelled";
  if (state.phase === "unrecorded") return "No result recorded";
  if (state.queued === true) return "Waiting to start";
  if (state.phase === "partial" || state.phase === "running") return "Working…";
  return "";
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized;
}

function formatRaw(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? "" : json;
  } catch {
    return "[Unserializable result]";
  }
}

function previewOutput(
  raw: string,
  meta: OutputMeta | undefined,
  expanded: boolean,
): { text: string; truncated: boolean } {
  if (expanded) return { text: raw, truncated: false };
  const lines = raw.split("\n");
  if (lines.length <= MAX_PREVIEW_LINES && raw.length <= MAX_PREVIEW_CHARACTERS) {
    return { text: raw, truncated: meta?.truncation !== undefined };
  }
  const preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n").slice(0, MAX_PREVIEW_CHARACTERS);
  return { text: `${preview}${preview.length < raw.length ? "\n…" : ""}`, truncated: true };
}

function truncationLabel(meta: OutputMeta | undefined): string {
  const truncation = meta?.truncation;
  if (truncation === undefined) return "Output preview shortened";
  const omitted = [
    truncation.omittedLines === undefined ? "" : `${truncation.omittedLines} lines`,
    truncation.omittedBytes === undefined ? "" : `${truncation.omittedBytes} bytes`,
  ].filter(Boolean);
  return omitted.length > 0
    ? `Output shortened; omitted ${omitted.join(" and ")}`
    : "Output shortened";
}
