import type { OmpWire } from "@omp-app/contracts";
import { useState } from "react";
import type { PanelState } from "@/modules/U5/panel/contract";
import type { CompactionState } from "../contract";
import {
  AutomaticCompactionOutcome,
  AutomaticCompactionProgress,
  CacheMissDivider,
  CacheWarmingNotice,
  CompactionPanel,
  CompactionSummaryDivider,
} from "./index";

const keptSummary: OmpWire.CompactionSummaryMessage = {
  role: "compactionSummary",
  summary: "## Current work\n\n- Keep the migration plan.\n- Continue from the latest review.",
  tokensBefore: 82_000,
  tokensAfter: 18_400,
  timestamp: 1_759_600_000_000,
  method: "remote",
  shortSummary: "Keep the migration plan and continue from the latest review.",
};

const previewResult: OmpWire.CompactionResult = {
  summary: "## Kept context\n\n- The current goal\n- The latest decision",
  firstKeptEntryId: "entry-kept",
  tokensBefore: 82_000,
};

const initialCompaction: CompactionState = {
  phase: "running",
  method: "threshold",
  auto: true,
  result: null,
  error: null,
  revision: "compaction-playground",
};

const initialPanel: PanelState = {
  open: true,
  lifecycle: "populated",
  position: "right",
  title: "Conversation context",
  description: "Review conversation maintenance and compaction.",
  error: null,
  readOnly: false,
  pendingUpdates: 0,
};

const previousUsage: OmpWire.Usage = {
  input: 2_400,
  output: 160,
  cacheRead: 21_000,
  cacheWrite: 0,
  totalTokens: 23_560,
  cost: { input: 2_400, output: 160, cacheRead: 21_000, cacheWrite: 0, total: 23_560 },
};

const currentUsage: OmpWire.Usage = {
  input: 3_200,
  output: 210,
  cacheRead: 0,
  cacheWrite: 21_600,
  totalTokens: 25_010,
  cost: { input: 3_200, output: 210, cacheRead: 0, cacheWrite: 21_600, total: 25_010 },
};

const automaticStart: OmpWire.AutoCompactionStartEvent = {
  type: "auto_compaction_start",
  reason: "threshold",
  action: "remote",
};

const automaticEnd: OmpWire.AutoCompactionEndEvent = {
  type: "auto_compaction_end",
  action: "remote",
  aborted: false,
  willRetry: true,
  errorMessage: "The provider did not accept the first request.",
};

const cacheWarming: OmpWire.CacheWarmingEndEvent = {
  type: "cache_warming_end",
  phase: "idle",
  provider: "sample-provider",
  model: "sample-model",
  outcome: "hit",
};

export function CompactionPlayground() {
  const [compaction, setCompaction] = useState(initialCompaction);
  const [panelState, setPanelState] = useState(initialPanel);

  const onCompact = () => {
    setCompaction((current) => ({
      ...current,
      phase: "completed",
      method: "manual",
      result: previewResult,
      error: null,
      revision: "compaction-playground-updated",
    }));
  };

  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Compaction preview</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Automatic maintenance, cache misses, and a summary of what the conversation kept.
        </p>
      </header>
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <section aria-label="Conversation history" className="min-w-0 space-y-3">
          <CompactionSummaryDivider message={keptSummary} />
          <CacheMissDivider
            currentAssistantUsage={currentUsage}
            previousAssistantUsage={previousUsage}
          />
          <AutomaticCompactionOutcome event={automaticEnd} />
          <AutomaticCompactionProgress event={automaticStart} />
          <CacheWarmingNotice event={cacheWarming} />
        </section>
        <aside
          className="border-sidebar-border bg-sidebar min-w-0 border-s"
          data-u0-right-sidebar="true"
        >
          <CompactionPanel
            autoAction={{ state: "available" }}
            compaction={compaction}
            manualAction={{ state: "available" }}
            onAutoCompactionChange={(enabled) =>
              setCompaction((current) => ({ ...current, auto: enabled }))
            }
            onCompact={onCompact}
            onOpenChange={(open) => setPanelState((current) => ({ ...current, open }))}
            panelState={panelState}
          />
        </aside>
      </div>
    </main>
  );
}
