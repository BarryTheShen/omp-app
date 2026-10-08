import { AppFailure } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentRef } from "@/modules/P1/contract";
import {
  type AgentHubActions,
  type AgentHubController,
  createAgentHubController,
} from "./controller";
import {
  FIXTURE_NOW,
  fixtureClock,
  fixtureRoster,
  fixtureWorker,
  lifecycleEvent,
} from "./fixtures";
import { AgentHubPanel, type AgentHubPanelProps } from "./hub";
import { buildHubModel, type HubModel } from "./model";
import { useAgentHub } from "./use-agent-hub";

const NO_TRANSCRIPT = {
  state: "unavailable",
  reason: "The transcript view is not open here.",
} as const;

afterEach(() => {
  cleanup();
});

function emptyModel(patch: Partial<HubModel>): HubModel {
  return {
    title: "Agent Hub",
    lifecycle: "empty",
    description: null,
    error: null,
    view: "list",
    sections: [],
    inspector: null,
    ...patch,
  };
}

function noop(): void {}

function panelProps(model: HubModel, patch: Partial<AgentHubPanelProps> = {}): AgentHubPanelProps {
  return {
    model,
    onOpenChange: noop,
    onViewChange: noop,
    onSelect: noop,
    onCancel: noop,
    onOpenTranscript: noop,
    ...patch,
  };
}

/** The panel fed by a real controller and a real roster store, as the composition will wire it. */
function LiveHub({ controller }: { readonly controller: AgentHubController }) {
  const state = useAgentHub(controller);
  return (
    <AgentHubPanel
      {...panelProps(state.model, {
        onViewChange: (next) => controller.setView(next),
        onSelect: (key) => controller.select(key),
        onCancel: (key) => void controller.cancel(key),
        onOpenTranscript: (key) => controller.openTranscript(key),
      })}
    />
  );
}

async function liveController(
  run: (agent: AgentRef) => Promise<unknown>,
  openTranscript?: AgentHubActions["openTranscript"],
) {
  const clock = fixtureClock();
  const store = await fixtureRoster({
    clock,
    workers: [
      fixtureWorker("runner", 1, { description: "Scan the repo" }),
      fixtureWorker("queued", 2, { status: "pending" }),
      fixtureWorker("finished", 3),
    ],
    events: [{ at: FIXTURE_NOW + 40, seq: 1, event: lifecycleEvent("finished", 3, "completed") }],
  });
  const controller = createAgentHubController({
    roster: store,
    initialLoad: { state: "ready" },
    actions: () => ({
      cancel: { state: "available", run },
      openTranscript: openTranscript ?? NO_TRANSCRIPT,
    }),
  });
  return { store, controller };
}

describe("AgentHubPanel states", () => {
  test("loading, empty, error and unavailable each replace the body with their own status", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <AgentHubPanel {...panelProps(emptyModel({ lifecycle: "loading" }))} />,
    );
    expect(
      screen.getByRole("region", { name: "Agent Hub" }).getAttribute("data-panel-lifecycle"),
    ).toBe("loading");
    expect(screen.getByRole("status").textContent).toContain("Loading");

    rerender(<AgentHubPanel {...panelProps(emptyModel({ lifecycle: "empty" }))} />);
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();

    rerender(
      <AgentHubPanel
        {...panelProps(
          emptyModel({
            lifecycle: "error",
            error: { code: "omp_error", message: "The roster request failed", retryable: true },
          }),
          { onRetry },
        )}
      />,
    );
    expect(screen.getByText("The roster request failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <AgentHubPanel
        {...panelProps(
          emptyModel({
            lifecycle: "unavailable",
            error: {
              code: "unavailable",
              message: "This omp has no subagent roster.",
              retryable: false,
            },
          }),
        )}
      />,
    );
    expect(screen.getByText("This omp has no subagent roster.")).toBeTruthy();
  });
});

describe("AgentHub live roster", () => {
  test("lists active and recent workers, opens the inspector on selection, and cancels a running worker once", async () => {
    let settle: () => void = noop;
    const run = vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      settle = () => resolve({ cancelled: true });
      return promise;
    });
    const { controller } = await liveController(run);
    render(<LiveHub controller={controller} />);

    expect(screen.getByRole("region", { name: "Agent Hub" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Active" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Recent" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Scan the repo/ }).textContent).toContain("Running");
    expect(screen.getByRole("option", { name: /Finished/ })).toBeTruthy();
    expect(screen.getByText("1 running · 1 queued · 1 recent")).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /Scan the repo/ }));
    expect(
      screen.getByRole("option", { name: /Scan the repo/ }).getAttribute("aria-selected"),
    ).toBe("true");
    const cancel = screen.getByRole("button", { name: "Cancel Scan the repo" });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancelling…" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      settle();
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Cancel sent. Waiting for the worker to stop.",
    );
  });

  test("a passive progress update neither moves focus nor changes the selection", async () => {
    const run = vi.fn(async () => ({ cancelled: true }));
    const { store, controller } = await liveController(run);
    render(<LiveHub controller={controller} />);
    fireEvent.click(screen.getByRole("option", { name: /Scan the repo/ }));
    const cancel = screen.getByRole("button", { name: "Cancel Scan the repo" });
    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    act(() => {
      store.ingestNotification(
        {
          type: "subagent_progress",
          payload: {
            index: 1,
            agent: "task",
            agentSource: "bundled",
            task: "scan",
            progress: { currentTool: "read", toolCount: 7, durationMs: 9_000 },
          },
        },
        2,
      );
    });
    expect(screen.getByRole("option", { name: /Scan the repo/ }).textContent).toContain(
      "Using read",
    );
    expect(document.activeElement).toBe(cancel);
    expect(
      screen.getByRole("option", { name: /Scan the repo/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("arrow keys move focus between workers, with one worker in the tab order", async () => {
    const { controller } = await liveController(async () => ({ cancelled: true }));
    render(<LiveHub controller={controller} />);
    const running = screen.getByRole("option", { name: /Scan the repo/ });
    const queued = screen.getByRole("option", { name: /queued/i });
    expect(running.getAttribute("tabindex")).toBe("0");
    expect(queued.getAttribute("tabindex")).toBe("-1");
    running.focus();
    fireEvent.keyDown(running, { key: "ArrowDown" });
    expect(document.activeElement).toBe(queued);
    fireEvent.keyDown(queued, { key: "ArrowUp" });
    expect(document.activeElement).toBe(running);
  });

  test("a failed cancel says what happened in plain words, with a retry, and the retry sends it again", async () => {
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(
        new AppFailure({
          code: "omp_error",
          message: "Subagent cancel request failed",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({ cancelled: true });
    const { controller } = await liveController(run);
    render(<LiveHub controller={controller} />);
    fireEvent.click(screen.getByRole("option", { name: /Scan the repo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel Scan the repo" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The worker could not be cancelled. Try again.")).toBeTruthy();
    expect(screen.queryByText("Subagent cancel request failed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Cancel sent. Waiting for the worker to stop.")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("a cancel that finds the worker already finished says so, and offers no retry", async () => {
    const run = vi.fn(async () => {
      throw new AppFailure({
        code: "not_found",
        message: "Subagent is no longer running",
        retryable: false,
      });
    });
    const { controller } = await liveController(run);
    render(<LiveHub controller={controller} />);
    fireEvent.click(screen.getByRole("option", { name: /Scan the repo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel Scan the repo" }));
    expect(
      await screen.findByText("This worker has already finished, so there is nothing to cancel."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("Subagent is no longer running")).toBeNull();
  });

  test("the transcript button explains why it cannot open, and opens through the callback when it can", async () => {
    const open = vi.fn();
    const { controller } = await liveController(async () => ({ cancelled: true }), {
      state: "available",
      open,
    });
    render(<LiveHub controller={controller} />);
    fireEvent.click(screen.getByRole("option", { name: /Scan the repo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "runner" }));
  });

  test("the list and by-parent toggle report the chosen view", async () => {
    const { controller } = await liveController(async () => ({ cancelled: true }));
    render(<LiveHub controller={controller} />);
    const list = screen.getByRole("button", { name: "List" });
    expect(list.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "By parent" }));
    expect(screen.getByRole("button", { name: "By parent" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("listbox", { name: "Started from this chat" })).toBeTruthy();
  });

  test("a model built from the store reads the same as the live view", async () => {
    const { store } = await liveController(async () => ({ cancelled: true }));
    const model = buildHubModel({
      roster: store.getSnapshot(),
      load: { state: "ready" },
      view: "list",
      selectedKey: null,
      cancels: {},
      cancelAction: { state: "available" },
      transcriptAction: NO_TRANSCRIPT,
    });
    render(<AgentHubPanel {...panelProps(model)} />);
    expect(screen.getByRole("listbox", { name: "Recent" })).toBeTruthy();
  });
});

describe("AgentHubPanel close control", () => {
  test("draws its Close control only when it is given an onOpenChange", () => {
    const { rerender } = render(
      <AgentHubPanel {...panelProps(emptyModel({}), { onOpenChange: undefined })} />,
    );
    expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();
    rerender(<AgentHubPanel {...panelProps(emptyModel({}))} />);
    expect(screen.getByRole("button", { name: "Close Agent Hub" })).toBeTruthy();
  });
});
