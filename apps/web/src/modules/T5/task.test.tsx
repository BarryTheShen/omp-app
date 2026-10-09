import { ThreadPrimitive } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentRef, NestedTranscriptSource } from "@/modules/P1/contract";
import { ReadOnlyThread } from "@/modules/P1/transcript";
import { agentRef, transcriptPage, userMessage } from "@/modules/P1/transcript/test/fixtures";
import { alteredResult, recorded } from "./recorded-props";
import { TaskCard, type TaskSubagentLookup, TaskSubagentsContext } from "./task";

/** The thread a task card sits in within the app: the read-only thread with its viewport. */
function InThread({ children }: { readonly children: ReactNode }) {
  return (
    <ReadOnlyThread messages={[]}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>{children}</ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ReadOnlyThread>
  );
}

afterEach(() => cleanup());

/** A worker's read-only source that holds one message: the transcript a card shows inside itself. */
function workerSource(agent: AgentRef, message: string): NestedTranscriptSource {
  return {
    agent,
    read: async () =>
      transcriptPage({ fromByte: 0, nextByte: 1, messages: [userMessage(message)] }),
    subscribe: () => () => undefined,
    readOnly: true,
  };
}

describe("T5 task card on recorded results", () => {
  test("one agent started in the background shows its job, its status and its counts", () => {
    render(<TaskCard rendererProps={recorded("task: one agent started in the background")} />);
    expect(screen.getByTestId("t5-task-card")).toBeTruthy();
    expect(screen.getByText("Running · 1 agent")).toBeTruthy();
    expect(screen.getByText("Background job BuilderTwo")).toBeTruthy();
    expect(screen.getByText("BuilderTwo")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Build one part of the app and open its pull request.")).toBeTruthy();
  });

  test("two reviewers started in the background show each agent", () => {
    render(<TaskCard rendererProps={recorded("task: two reviewers started in the background")} />);
    expect(screen.getByText("Running · 2 agents")).toBeTruthy();
    expect(screen.getByText("ReviewerOne")).toBeTruthy();
    expect(screen.getByText("ReviewerTwo")).toBeTruthy();
    expect(screen.getAllByText("Pending")).toHaveLength(2);
    expect(
      screen.getAllByText("Review one pull request against its issue and report the findings."),
    ).toHaveLength(2);
  });

  test("a preflight refusal says no agent started and shows the text omp returned", () => {
    render(<TaskCard rendererProps={recorded("task: a preflight failure, no agent started")} />);
    expect(screen.getByText("No agents reported")).toBeTruthy();
    expect(screen.getByTestId("t5-task-text").textContent).toContain("failed preflight");
  });

  test("a refused call shows omp's own words as its reason", () => {
    render(<TaskCard rendererProps={recorded("task: the call was refused")} />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Put each model selector on its tasks[] item, not on the batch container.",
    );
  });

  test("a progress status omp does not send is a visible error", () => {
    const props = alteredResult(
      "task: one agent started in the background",
      ["details", "progress", 0, "status"],
      "paused",
    );
    render(<TaskCard rendererProps={props} />);
    expect(screen.getByRole("alert").textContent).toContain("Malformed task");
  });
});

describe("T5.2 task card worker transcripts", () => {
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    // The thread viewport observes its size and scrolls; jsdom has neither, so the view gets no-ops.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: originalScrollTo,
    });
  });

  test("each worker the task call started shows its read-only transcript inside the card", async () => {
    const agent = agentRef({ parentToolCallId: "task-call", description: "Nested probe" });
    const lookup: TaskSubagentLookup = (parentToolCallId) =>
      parentToolCallId === "task-call"
        ? [{ agent, source: workerSource(agent, "worker task text for the probe") }]
        : [];
    const { container } = render(
      <TaskSubagentsContext.Provider value={lookup}>
        <InThread>
          <TaskCard rendererProps={recorded("task: one agent started in the background")} />
        </InThread>
      </TaskSubagentsContext.Provider>,
    );
    expect(await screen.findByText("worker task text for the probe")).toBeTruthy();
    const transcript = container.querySelector("[data-slot='t5-task-transcript']");
    expect(transcript?.textContent).toContain("Nested probe");
    expect(transcript?.textContent).toContain("Read only");
  });

  test("a background job whose only worker failed reads Failed, not Running, once the roster knows the worker", () => {
    const agent = agentRef({
      parentToolCallId: "task-call",
      status: "failed",
      description: "Fail probe",
    });
    const lookup: TaskSubagentLookup = (parentToolCallId) =>
      parentToolCallId === "task-call"
        ? [{ agent, source: workerSource(agent, "the failed worker's text") }]
        : [];
    const { container } = render(
      <TaskSubagentsContext.Provider value={lookup}>
        <InThread>
          <TaskCard rendererProps={recorded("task: one agent started in the background")} />
        </InThread>
      </TaskSubagentsContext.Provider>,
    );
    expect(screen.getByText("Failed · 1 agent")).toBeTruthy();
    expect(screen.queryByText("Running · 1 agent")).toBeNull();
    const job = container.querySelector("[data-slot='t5-task-job']");
    expect(job?.textContent).toContain("Failed");
    expect(job?.textContent).not.toContain("Running");
  });

  test("a worker the roster reports completed makes the job Completed, whatever the call's snapshot said", () => {
    const agent = agentRef({ parentToolCallId: "task-call", status: "completed" });
    const lookup: TaskSubagentLookup = (parentToolCallId) =>
      parentToolCallId === "task-call" ? [{ agent, source: workerSource(agent, "done") }] : [];
    const { container } = render(
      <TaskSubagentsContext.Provider value={lookup}>
        <InThread>
          <TaskCard rendererProps={recorded("task: one agent started in the background")} />
        </InThread>
      </TaskSubagentsContext.Provider>,
    );
    expect(screen.getByText("Completed · 1 agent")).toBeTruthy();
    expect(container.querySelector("[data-slot='t5-task-job']")?.textContent).toContain(
      "Completed",
    );
  });

  test("a roster that knows one of two workers, finished, does not settle the job: the call's own state stands", () => {
    const agent = agentRef({ parentToolCallId: "task-call", status: "completed" });
    const lookup: TaskSubagentLookup = (parentToolCallId) =>
      parentToolCallId === "task-call" ? [{ agent, source: workerSource(agent, "done") }] : [];
    render(
      <TaskSubagentsContext.Provider value={lookup}>
        <InThread>
          <TaskCard rendererProps={recorded("task: two reviewers started in the background")} />
        </InThread>
      </TaskSubagentsContext.Provider>,
    );
    expect(screen.getByText("Running · 2 agents")).toBeTruthy();
    expect(screen.queryByText("Completed · 2 agents")).toBeNull();
  });

  test("a failure the roster knows stands even when it knows only one of the two workers", () => {
    const agent = agentRef({ parentToolCallId: "task-call", status: "failed" });
    const lookup: TaskSubagentLookup = (parentToolCallId) =>
      parentToolCallId === "task-call" ? [{ agent, source: workerSource(agent, "failed") }] : [];
    render(
      <TaskSubagentsContext.Provider value={lookup}>
        <InThread>
          <TaskCard rendererProps={recorded("task: two reviewers started in the background")} />
        </InThread>
      </TaskSubagentsContext.Provider>,
    );
    expect(screen.getByText("Failed · 2 agents")).toBeTruthy();
  });

  test("a card with no lookup shows no transcript", () => {
    const { container } = render(
      <TaskCard rendererProps={recorded("task: one agent started in the background")} />,
    );
    expect(container.querySelector("[data-slot='t5-task-transcripts']")).toBeNull();
  });

  test("a call with no workers of its own shows none, even when another call has workers", () => {
    const agent = agentRef({ parentToolCallId: "another-call" });
    const lookup: TaskSubagentLookup = (parentToolCallId) =>
      parentToolCallId === "another-call"
        ? [{ agent, source: workerSource(agent, "another call's worker") }]
        : [];
    const { container } = render(
      <TaskSubagentsContext.Provider value={lookup}>
        <TaskCard rendererProps={recorded("task: one agent started in the background")} />
      </TaskSubagentsContext.Provider>,
    );
    expect(container.querySelector("[data-slot='t5-task-transcripts']")).toBeNull();
  });

  test("an agent row shows the worker's live status from the roster, not the spawn snapshot", () => {
    const agent = agentRef({
      id: "BuilderTwo",
      parentToolCallId: "task-call",
      status: "running",
      description: "Build part two",
    });
    const lookup: TaskSubagentLookup = (parentToolCallId) =>
      parentToolCallId === "task-call"
        ? [{ agent, source: workerSource(agent, "live worker text") }]
        : [];
    const { container } = render(
      <TaskSubagentsContext.Provider value={lookup}>
        <InThread>
          <TaskCard rendererProps={recorded("task: one agent started in the background")} />
        </InThread>
      </TaskSubagentsContext.Provider>,
    );
    const row = container.querySelector("[data-slot='t5-task-progress'] li");
    expect(row?.textContent).toContain("Running");
    expect(row?.textContent).not.toContain("Pending");
  });
});
