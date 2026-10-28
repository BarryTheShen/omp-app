import type { Omp } from "@omp-app/contracts";
import { useId } from "react";
import { InlineError, Section, SettingRow } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/modules/U1/markdown";
import type {
  PanelActionAvailability,
  PanelFocusToken,
  PanelOpenReason,
  PanelState,
} from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import type { CompactionState } from "../contract";
import { formatTokenCount } from "./models";

export interface CompactionPanelProps {
  readonly panelState: PanelState;
  readonly compaction: CompactionState;
  readonly manualAction: PanelActionAvailability;
  readonly autoAction: PanelActionAvailability;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly onCompact: () => void;
  readonly onAutoCompactionChange: (enabled: boolean) => void;
}

function CompactionResultSummary({ result }: { readonly result: Omp.CompactionResult }) {
  const summary = result.summary.trim();
  return (
    <Section heading="What was kept" headingLevel={3} variant="plain">
      <p className="text-muted-foreground mb-2 text-sm">
        omp compacted a conversation that used {formatTokenCount(result.tokensBefore)} tokens. The
        conversation now continues from the first message it kept.
      </p>
      {summary.length > 0 ? (
        <details>
          <summary className="cursor-pointer rounded-sm text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Read the compaction summary
          </summary>
          <div className="border-border bg-muted/20 mt-2 max-h-80 overflow-auto rounded-lg border p-3 text-sm">
            <MarkdownContent text={summary} variant="compact" />
          </div>
        </details>
      ) : (
        <p className="text-muted-foreground text-sm">No compaction summary was provided.</p>
      )}
    </Section>
  );
}

function CompactionLifecycle({
  onRetry,
  state,
}: {
  readonly onRetry: () => void;
  readonly state: CompactionState;
}) {
  switch (state.phase) {
    case "idle":
      return null;
    case "running":
      return (
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          omp is compacting your conversation.
        </p>
      );
    case "completed":
      return (
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          Compaction finished. Your conversation is still available.
        </p>
      );
    case "skipped":
      return (
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          Compaction was skipped. Your conversation is unchanged.
        </p>
      );
    case "aborted":
      return (
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          Compaction was cancelled. Your conversation is still here.
        </p>
      );
    case "error":
      return state.error ? (
        <InlineError
          heading="Compaction could not finish"
          message={state.error.message}
          onRetry={state.error.retryable ? onRetry : undefined}
          retryLabel="Try again"
        />
      ) : (
        <p aria-live="polite" className="text-destructive text-sm" role="alert">
          Compaction could not finish. Your conversation is still available.
        </p>
      );
  }
}

export function CompactionPanel({
  panelState,
  compaction,
  manualAction,
  autoAction,
  invokingFocus,
  restoreFocus,
  onOpenChange,
  onCompact,
  onAutoCompactionChange,
}: CompactionPanelProps) {
  const manualReasonId = useId();
  const autoReasonId = useId();
  const manualReason = manualAction.state === "unavailable" ? manualAction.reason : undefined;
  const autoReason = autoAction.state === "unavailable" ? autoAction.reason : undefined;
  const busy =
    compaction.phase === "running" ||
    panelState.lifecycle === "loading" ||
    panelState.lifecycle === "updating";
  const manualDisabled = busy || panelState.readOnly || manualAction.state === "unavailable";
  const autoDisabled = busy || panelState.readOnly || autoAction.state === "unavailable";

  const body = (
    <div aria-busy={busy} className="flex min-w-0 flex-col gap-4" data-p7-compaction-panel>
      <Section heading="Compaction controls" headingLevel={3} variant="plain">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={manualDisabled} onClick={onCompact} type="button" variant="outline">
            Compact now
          </Button>
          {panelState.readOnly ? (
            <p className="text-muted-foreground text-sm">This conversation is read-only.</p>
          ) : null}
          {manualReason ? (
            <p className="text-muted-foreground text-sm" id={manualReasonId} role="status">
              {manualReason}
            </p>
          ) : null}
        </div>
        <SettingRow
          description="Reduce context automatically when the conversation needs more room."
          title="Automatic compaction"
        >
          <input
            aria-describedby={autoReason ? autoReasonId : undefined}
            aria-label="Automatic compaction"
            checked={compaction.auto}
            disabled={autoDisabled}
            onChange={(event) => onAutoCompactionChange(event.currentTarget.checked)}
            type="checkbox"
          />
        </SettingRow>
        {autoReason ? (
          <p className="text-muted-foreground text-sm" id={autoReasonId} role="status">
            {autoReason}
          </p>
        ) : null}
      </Section>
      <CompactionLifecycle onRetry={onCompact} state={compaction} />
      {compaction.phase === "completed" && compaction.result ? (
        <CompactionResultSummary result={compaction.result} />
      ) : null}
    </div>
  );

  return (
    <PanelShell
      body={body}
      invokingFocus={invokingFocus}
      restoreFocus={restoreFocus}
      onOpenChange={onOpenChange}
      state={panelState}
    />
  );
}
