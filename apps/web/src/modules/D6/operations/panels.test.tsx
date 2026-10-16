import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fixtureAgent, fixtureClock, fixtureRosterStore } from "@/modules/P1/fixtures/common";
import { RECORDED_PROGRESS } from "@/modules/P1/fixtures/roster";
import type { BtwPanelModel } from "./model";
import { BTW_STATUS_LABEL, btwModelOf, cleanseModelOf, omfgModelOf, pauseModelOf } from "./model";
import { operationsViews } from "./panels";

afterEach(cleanup);

const {
  btw: BtwPanel,
  cleanse: CleansePanel,
  omfg: OmfgPanel,
  pause: PausePanel,
} = operationsViews;
const noAction = {
  state: "unavailable" as const,
  reason: "This action is not available in this omp session.",
};
const unavailableReason = "These side questions are not available in this omp session.";

function recordedRoster() {
  const store = fixtureRosterStore(fixtureClock(1_000));
  store.mergeSnapshot([
    fixtureAgent("LongProbe", 0, {
      description: "Repository checker",
      progress: RECORDED_PROGRESS,
    }),
  ]);
  return store.getSnapshot();
}

describe("D6 operational panels", () => {
  test("uses ListRow arrow navigation and plain side-question statuses", () => {
    const onSelect = vi.fn();
    const model = btwModelOf({
      turns: [
        { id: "one", question: "First question", answer: "First answer", status: "complete" },
        { id: "two", question: "Second question", answer: "Second answer", status: "running" },
      ],
      selectedId: "one",
      copy: { state: "available" },
      cancel: { state: "available" },
      branch: noAction,
    });
    render(
      <BtwPanel
        model={model}
        onBranch={vi.fn()}
        onCancel={vi.fn()}
        onCopy={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const rows = screen.getAllByRole("option");
    expect(screen.getByText(BTW_STATUS_LABEL.complete, { exact: true })).toBeTruthy();
    expect(screen.getByText(BTW_STATUS_LABEL.running, { exact: true })).toBeTruthy();
    for (const raw of ["running", "complete", "cancelled", "error", "interrupted"]) {
      expect(rows.map((row) => row.textContent)).not.toContain(raw);
    }
    const first = rows[0];
    if (!first) throw new Error("The first side-question row is missing.");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("two");
    expect(document.activeElement).toBe(rows[1]);
    const second = rows[1];
    if (!second) throw new Error("The second side-question row is missing.");
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith("one");
    expect(document.activeElement).toBe(first);
    expect(screen.getAllByText(noAction.reason)).toHaveLength(1);
  });

  test("an unavailable action stays disabled and never calls its callback", () => {
    const onBranch = vi.fn();
    render(
      <BtwPanel
        model={btwModelOf({
          turns: [{ id: "one", question: "Question", answer: "Answer", status: "complete" }],
          branch: noAction,
        })}
        onBranch={onBranch}
        onCancel={vi.fn()}
        onCopy={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: /^Open in chat/ });
    expect(button.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(button);
    expect(onBranch).not.toHaveBeenCalled();
  });

  test("a side-question update uses PanelShell's follow-latest control when the reader scrolled away", () => {
    const modelFor = (answer: string) =>
      btwModelOf({
        turns: [{ id: "one", question: "Question", answer, status: "running" }],
        selectedId: "one",
        copy: { state: "available" },
        cancel: { state: "available" },
        branch: { state: "available" },
      });
    const view = render(
      <BtwPanel
        model={modelFor("First chunk")}
        onBranch={vi.fn()}
        onCancel={vi.fn()}
        onCopy={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const scroll = view.container.querySelector<HTMLDivElement>('[data-panel-scroll="body"]');
    if (!scroll) throw new Error("The side-question panel scroll area is missing.");
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
    });
    fireEvent.scroll(scroll);
    view.rerender(
      <BtwPanel
        model={modelFor("First chunk, then more output")}
        onBranch={vi.fn()}
        onCancel={vi.fn()}
        onCopy={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest panel updates" }));
    expect(scroll.scrollTop).toBe(200);
  });
  test("PanelShell owns the Btw empty, unavailable, error and updating notices", () => {
    const renderBtw = (model: BtwPanelModel) =>
      render(
        <BtwPanel
          model={model}
          onBranch={vi.fn()}
          onCancel={vi.fn()}
          onCopy={vi.fn()}
          onSelect={vi.fn()}
        />,
      );

    renderBtw(btwModelOf({ turns: [] }));
    expect(screen.getAllByText("Nothing here yet")).toHaveLength(1);
    expect(screen.queryByText("No side questions yet")).toBeNull();
    cleanup();

    renderBtw(btwModelOf({ turns: [], unavailableReason }));
    expect(screen.getAllByText(unavailableReason)).toHaveLength(1);
    cleanup();

    renderBtw(
      btwModelOf({
        turns: [],
        error: { code: "internal", message: "The side-question history failed.", retryable: true },
      }),
    );
    expect(screen.getAllByText("The side-question history failed.")).toHaveLength(1);
    cleanup();

    renderBtw(
      btwModelOf({
        turns: [{ id: "one", question: "Question", answer: "", status: "running" }],
      }),
    );
    expect(screen.getAllByText("Updating")).toHaveLength(1);
    expect(screen.getByText("Waiting for an answer…")).toBeTruthy();
  });

  test("a side-question error preserves its selected content", () => {
    render(
      <BtwPanel
        model={btwModelOf({
          turns: [
            {
              id: "question-1",
              question: "What changed?",
              answer: "The review found another detail.",
              status: "complete",
            },
          ],
          error: { code: "internal", message: "The question request failed.", retryable: true },
        })}
        onBranch={vi.fn()}
        onCancel={vi.fn()}
        onCopy={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByText("The question request failed.")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /What changed/ })).toBeTruthy();
    expect(screen.getByText("The review found another detail.")).toBeTruthy();
  });

  test("pause uses PanelShell's empty state while the local gate is closed", () => {
    render(
      <PausePanel
        model={pauseModelOf({
          snapshot: {
            open: false,
            openedAt: null,
            elapsedMs: 0,
            authoritative: false,
            reason: "The local gate is closed.",
          },
        })}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Nothing here yet")).toHaveLength(1);
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.getByRole("button", { name: "Resume" }).getAttribute("disabled")).not.toBeNull();
  });

  test("cleanse renders updating, empty, unavailable, failed-with-content and worker states", () => {
    const onCheck = vi.fn();
    const onCancel = vi.fn();
    const onRun = vi.fn();
    const running = cleanseModelOf({
      status: "running",
      agentIds: [],
      check: { state: "available" },
    });
    render(<CleansePanel model={running} onCancel={onCancel} onCheck={onCheck} onRun={onRun} />);
    expect(screen.getAllByText("Updating")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Find checkers" })).toBeTruthy();
    cleanup();

    const idle = cleanseModelOf({ status: "idle", agentIds: [] });
    render(<CleansePanel model={idle} onCancel={onCancel} onCheck={onCheck} onRun={onRun} />);
    expect(screen.getAllByText("Nothing here yet")).toHaveLength(1);
    cleanup();

    const unavailable = cleanseModelOf({
      status: "unknown",
      agentIds: [],
      message: "The cleanse status has not been confirmed.",
    });
    render(
      <CleansePanel model={unavailable} onCancel={onCancel} onCheck={onCheck} onRun={onRun} />,
    );
    expect(screen.getAllByText("The cleanse status has not been confirmed.")).toHaveLength(1);
    cleanup();

    const roster = recordedRoster();
    const workerKey = roster.order[0];
    const worker = workerKey === undefined ? undefined : roster.agents[workerKey];
    if (worker === undefined) throw new Error("The recorded roster worker is missing.");
    const failed = cleanseModelOf({
      status: "failed",
      agentIds: [worker.id],
      message: "Workers stopped after the failed check.",
      error: { code: "internal", message: "The check failed.", retryable: true },
      roster,
    });
    render(<CleansePanel model={failed} onCancel={onCancel} onCheck={onCheck} onRun={onRun} />);
    expect(screen.getAllByText("The check failed.")).toHaveLength(1);
    expect(screen.getAllByText("Workers stopped after the failed check.")).toHaveLength(1);
    expect(screen.getByText("Repository checker")).toBeTruthy();
    expect(screen.getByText(/Using bash/)).toBeTruthy();
  });

  test("omfg renders empty, unavailable, updating and failed-with-content states", () => {
    const onAmend = vi.fn();
    const onCancel = vi.fn();
    const onSave = vi.fn();
    render(
      <OmfgPanel
        model={omfgModelOf({ status: "idle", complaint: "" })}
        onAmend={onAmend}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    expect(screen.getAllByText("Nothing here yet")).toHaveLength(1);
    cleanup();

    render(
      <OmfgPanel
        model={omfgModelOf({
          status: "unknown",
          complaint: "",
          unavailableReason: "Rule-draft status is not available.",
        })}
        onAmend={onAmend}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    expect(screen.getAllByText("Rule-draft status is not available.")).toHaveLength(1);
    cleanup();

    render(
      <OmfgPanel
        model={omfgModelOf({
          status: "saving",
          complaint: "Please inspect this result.",
          candidate: "Inspect before replying.",
        })}
        onAmend={onAmend}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    expect(screen.getAllByText("Updating")).toHaveLength(1);
    expect(screen.getByText("Inspect before replying.")).toBeTruthy();
    cleanup();

    render(
      <OmfgPanel
        model={omfgModelOf({
          status: "failed",
          complaint: "A long complaint",
          candidate: "A candidate retained after failure.",
          error: { code: "internal", message: "The rule draft failed.", retryable: true },
        })}
        onAmend={onAmend}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    expect(screen.getAllByText("The rule draft failed.")).toHaveLength(1);
    expect(screen.getByText("A long complaint")).toBeTruthy();
    expect(screen.getByText("A candidate retained after failure.")).toBeTruthy();
  });

  test("shows the local pause elapsed time and uses the typed pause snapshot", () => {
    const onResume = vi.fn();
    render(
      <PausePanel
        model={pauseModelOf({
          snapshot: {
            open: true,
            openedAt: 1_000,
            elapsedMs: 65_000,
            authoritative: false,
            reason: "Paused locally while you review the work.",
          },
          resume: { state: "available" },
        })}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledOnce();
    const timer = screen.getByRole("timer");
    expect(timer.textContent).toBe("1 min 5 s");
    expect(timer.getAttribute("aria-live")).toBeNull();
    expect(screen.getByText("Pause is local to this app and does not stop omp work.")).toBeTruthy();
  });
});
