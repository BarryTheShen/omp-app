import type { Omp } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PanelActionAvailability, PanelState } from "@/modules/U5/panel/contract";
import type { CompactionState } from "../contract";
import {
  AutomaticCompactionOutcome,
  AutomaticCompactionProgress,
  CacheMissDivider,
  CacheWarmingNotice,
  CompactionPanel,
  CompactionSummaryDivider,
  cacheMissBetween,
} from "./index";

afterEach(cleanup);

function usage(input: number, cacheRead: number, cacheWrite: number): Omp.Usage {
  const total = input + cacheRead + cacheWrite;
  return {
    input,
    output: 0,
    cacheRead,
    cacheWrite,
    totalTokens: total,
    cost: { input, output: 0, cacheRead, cacheWrite, total },
  };
}

function compactionState(overrides: Partial<CompactionState> = {}): CompactionState {
  return {
    phase: "idle",
    method: null,
    auto: true,
    result: null,
    error: null,
    revision: "compaction-test",
    ...overrides,
  };
}

function panelState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    open: true,
    lifecycle: "populated",
    position: "right",
    title: "Conversation context",
    description: "Review conversation maintenance and compaction.",
    error: null,
    readOnly: false,
    pendingUpdates: 0,
    ...overrides,
  };
}

const available: PanelActionAvailability = { state: "available" };
const ignorePanelOpenChange = vi.fn();
const ignoreCompactionAction = vi.fn();
const ignoreAutoCompactionChange = vi.fn();

function renderPanel(
  state: CompactionState,
  overrides: {
    readonly manualAction?: PanelActionAvailability;
    readonly autoAction?: PanelActionAvailability;
    readonly panel?: PanelState;
    readonly onCompact?: () => void;
    readonly onAutoCompactionChange?: (enabled: boolean) => void;
  } = {},
) {
  const onCompact = overrides.onCompact ?? vi.fn();
  const onAutoCompactionChange = overrides.onAutoCompactionChange ?? vi.fn();
  const result = render(
    <CompactionPanel
      autoAction={overrides.autoAction ?? available}
      compaction={state}
      manualAction={overrides.manualAction ?? available}
      onAutoCompactionChange={onAutoCompactionChange}
      onCompact={onCompact}
      onOpenChange={ignorePanelOpenChange}
      panelState={overrides.panel ?? panelState()}
    />,
  );
  return { ...result, onAutoCompactionChange, onCompact };
}

const summaryMessage: Omp.CompactionSummaryMessage = {
  role: "compactionSummary",
  summary: "## Kept context\n\n- Keep the current goal\n\n[unsafe link](javascript:alert(1))",
  tokensBefore: 120_000,
  tokensAfter: 28_000,
  timestamp: 1_759_600_000_000,
  method: "remote",
  shortSummary: "Keep the current goal and latest decision.",
};

describe("P7 compaction and cache dividers", () => {
  test("marks only an explicit warm-to-cold cache transition and counts reprocessed tokens", () => {
    expect(cacheMissBetween(null, usage(300, 0, 800))).toBeNull();
    expect(cacheMissBetween(usage(300, 0, 800), usage(300, 0, 800))).toBeNull();
    expect(cacheMissBetween(usage(300, 4_000, 0), usage(300, 12, 800))).toBeNull();
    expect(cacheMissBetween(usage(300, 4_000, 0), usage(300, 0, 800))).toEqual({
      reprocessedTokens: 1_100,
    });
  });

  test("renders the cache-miss row before the cold turn with a plain token count", () => {
    const { rerender, container } = render(
      <CacheMissDivider currentAssistantUsage={usage(300, 0, 800)} previousAssistantUsage={null} />,
    );
    expect(container.querySelector("[data-p7-cache-miss-divider]")).toBeNull();
    rerender(
      <CacheMissDivider
        currentAssistantUsage={usage(300, 0, 800)}
        previousAssistantUsage={usage(300, 4_000, 0)}
      />,
    );
    expect(
      screen.getByText("The prompt cache went cold, so omp processed 1,100 tokens again."),
    ).toBeTruthy();
  });

  test("shows the file names of omp's compaction summary as plain lists", () => {
    const summary = "## Kept context\n\n<files>\n# src/\nparser.ts (Read)\nstore.ts (RW)\n</files>";
    const { container } = render(
      <CompactionSummaryDivider message={{ ...summaryMessage, summary }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Files read");
    expect(text).toContain("src/parser.ts");
    expect(text).toContain("src/store.ts");
    expect(text).not.toContain("<files>");
  });

  test("places an expandable safe summary at the compaction point with before and after counts", () => {
    const { container } = render(<CompactionSummaryDivider message={summaryMessage} />);
    expect(screen.getByRole("button", { name: "Conversation compacted remotely" })).toBeTruthy();
    expect(screen.getByText("Keep the current goal and latest decision.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Conversation compacted remotely" }));
    expect(
      screen.getByText("Before compaction: 120,000 tokens. After compaction: 28,000 tokens."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Read what was kept"));
    expect(screen.getByRole("heading", { name: "Kept context" })).toBeTruthy();
    expect(screen.getByText("Keep the current goal")).toBeTruthy();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.textContent).not.toContain("entry-");
  });

  test("keeps compaction warnings and errors visible beside the divider", () => {
    render(
      <CompactionSummaryDivider
        error="The compaction summary could not be completed."
        message={summaryMessage}
        warning="The existing conversation remains available."
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "existing conversation remains available",
    );
    expect(screen.getByRole("alert").textContent).toContain("summary could not be completed");
  });

  test("falls back to a plain compaction label for unknown method names", () => {
    const message = { ...summaryMessage, method: "private-method-name" };
    render(<CompactionSummaryDivider message={message} />);
    expect(screen.getByRole("button", { name: "Conversation compacted" })).toBeTruthy();
    expect(screen.queryByText("private-method-name")).toBeNull();
  });
});

describe("P7 compaction panel", () => {
  test("routes manual and automatic actions through callbacks without owning omp's state", () => {
    const onCompact = vi.fn();
    const onAutoCompactionChange = vi.fn();
    renderPanel(compactionState(), { onCompact, onAutoCompactionChange });
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Automatic compaction" }));
    expect(onCompact).toHaveBeenCalledOnce();
    expect(onAutoCompactionChange).toHaveBeenCalledWith(false);
  });

  test("shows a capability reason and disables unavailable actions without exposing internal names", () => {
    renderPanel(compactionState(), {
      manualAction: {
        state: "unavailable",
        reason: "Manual compaction is not available for this conversation.",
        capability: "omp.cmd.compact",
      },
    });
    expect(screen.getByRole("button", { name: "Compact now" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Manual compaction is not available for this conversation."),
    ).toBeTruthy();
    expect(screen.queryByText("omp.cmd.compact")).toBeNull();
  });

  test("renders completed work and offers retry only for a retryable typed error", () => {
    const onCompact = vi.fn();
    renderPanel(
      compactionState({
        phase: "completed",
        result: {
          summary: "## Kept\n\n- The current task",
          firstKeptEntryId: "entry-keep",
          tokensBefore: 12_000,
        },
      }),
      { onCompact },
    );
    expect(screen.getByText(/omp compacted a conversation that used 12,000 tokens/)).toBeTruthy();
    fireEvent.click(screen.getByText("Read the compaction summary"));
    expect(screen.getByRole("heading", { name: "Kept" })).toBeTruthy();

    cleanup();
    renderPanel(
      compactionState({
        phase: "error",
        error: { code: "timeout", message: "The request timed out.", retryable: true },
      }),
      { onCompact },
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onCompact).toHaveBeenCalledOnce();
  });

  test("shows running, skipped, aborted, and non-retryable failure states without losing the panel", () => {
    const { rerender, container } = renderPanel(compactionState({ phase: "running" }));
    expect(screen.getByRole("status").textContent).toContain("omp is compacting");
    expect(screen.getByRole("button", { name: "Compact now" }).hasAttribute("disabled")).toBe(true);

    rerender(
      <CompactionPanel
        autoAction={available}
        compaction={compactionState({ phase: "skipped" })}
        manualAction={available}
        onAutoCompactionChange={ignoreAutoCompactionChange}
        onCompact={ignoreCompactionAction}
        onOpenChange={ignorePanelOpenChange}
        panelState={panelState()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("was skipped");

    rerender(
      <CompactionPanel
        autoAction={available}
        compaction={compactionState({ phase: "aborted" })}
        manualAction={available}
        onAutoCompactionChange={ignoreAutoCompactionChange}
        onCompact={ignoreCompactionAction}
        onOpenChange={ignorePanelOpenChange}
        panelState={panelState()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("was cancelled");

    rerender(
      <CompactionPanel
        autoAction={available}
        compaction={compactionState({
          phase: "error",
          error: { code: "timeout", message: "The request timed out.", retryable: false },
        })}
        manualAction={available}
        onAutoCompactionChange={ignoreAutoCompactionChange}
        onCompact={ignoreCompactionAction}
        onOpenChange={ignorePanelOpenChange}
        panelState={panelState()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The request timed out.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(container.querySelector('[data-panel-open="true"]')).toBeTruthy();
  });
});

describe("P7 automatic compaction and cache warming events", () => {
  test("announces automatic compaction start with plain language", () => {
    const event: Omp.AutoCompactionStartEvent = {
      type: "auto_compaction_start",
      reason: "overflow",
      action: "remote",
    };
    render(<AutomaticCompactionProgress event={event} />);
    expect(screen.getByRole("status").textContent).toContain("context limit");
    expect(screen.getByRole("status").textContent).toContain("remote summary");
  });

  test("distinguishes automatic success, skip, cancellation, retry warning, and failure", () => {
    const success: Omp.AutoCompactionEndEvent = {
      type: "auto_compaction_end",
      action: "remote",
      aborted: false,
      willRetry: false,
      result: {
        summary: "The current plan remains.",
        firstKeptEntryId: "entry-kept",
        tokensBefore: 20_000,
      },
    };
    const skipped: Omp.AutoCompactionEndEvent = {
      type: "auto_compaction_end",
      action: "remote",
      result: undefined,
      aborted: false,
      willRetry: false,
      skipped: true,
    };
    const aborted: Omp.AutoCompactionEndEvent = {
      type: "auto_compaction_end",
      action: "remote",
      result: undefined,
      aborted: true,
      willRetry: false,
    };
    const warning: Omp.AutoCompactionEndEvent = {
      type: "auto_compaction_end",
      action: "remote",
      result: undefined,
      aborted: false,
      willRetry: true,
      errorMessage: "The provider did not accept the first request.",
    };
    const error: Omp.AutoCompactionEndEvent = {
      type: "auto_compaction_end",
      action: "remote",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "The provider rejected the request.",
    };

    const { rerender } = render(<AutomaticCompactionOutcome event={success} />);
    expect(screen.getByRole("status").textContent).toContain("finished");
    rerender(<AutomaticCompactionOutcome event={skipped} />);
    expect(screen.getByRole("status").textContent).toContain("was skipped");
    rerender(<AutomaticCompactionOutcome event={aborted} />);
    expect(screen.getByRole("status").textContent).toContain("was cancelled");
    rerender(<AutomaticCompactionOutcome event={warning} />);
    expect(screen.getByRole("status").textContent).toContain("will try again");
    rerender(<AutomaticCompactionOutcome event={error} />);
    expect(screen.getByRole("alert").textContent).toContain("provider rejected");
  });

  test("renders cache-refresh progress and distinct outcomes", () => {
    const start: Omp.CacheWarmingStartEvent = {
      type: "cache_warming_start",
      phase: "idle",
      provider: "sample-provider",
      model: "sample-model",
    };
    const { rerender } = render(<CacheWarmingNotice event={start} />);
    expect(screen.getByRole("status").textContent).toContain("refreshing the prompt cache");

    rerender(
      <CacheWarmingNotice
        event={{
          type: "cache_warming_end",
          phase: "idle",
          provider: "sample-provider",
          model: "sample-model",
          outcome: "hit",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("is ready");

    rerender(
      <CacheWarmingNotice
        event={{
          type: "cache_warming_end",
          phase: "idle",
          provider: "sample-provider",
          model: "sample-model",
          outcome: "miss",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("not available");

    rerender(
      <CacheWarmingNotice
        event={{
          type: "cache_warming_end",
          phase: "idle",
          provider: "sample-provider",
          model: "sample-model",
          outcome: "error",
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("could not refresh");

    rerender(
      <CacheWarmingNotice
        event={{
          type: "cache_warming_end",
          phase: "idle",
          provider: "sample-provider",
          model: "sample-model",
          outcome: "aborted",
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("was cancelled");
  });
});
