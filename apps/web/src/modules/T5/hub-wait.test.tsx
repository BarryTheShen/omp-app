import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { HubCard } from "./hub";
import { decodeWaitDetails } from "./models";
import { alteredResult, recorded, sampleNamed } from "./recorded-props";
import { WaitCard } from "./wait";

afterEach(() => cleanup());

describe("T5.3 wait card on recorded results", () => {
  test("a message from another agent shows who sent it and what it said", () => {
    const { container } = render(
      <WaitCard rendererProps={recorded("wait: a message from another agent")} />,
    );
    expect(screen.getByText("Message from BuilderOne")).toBeTruthy();
    expect(container.querySelector("[data-slot='t5-message']")?.textContent).toContain(
      "From BuilderOne to Main",
    );
    expect(container.querySelector("[data-slot='t5-message']")?.textContent).toContain(
      "Understood. I will leave the warning-only findings",
    );
  });

  test("running jobs and a finished command show their status, progress and result", () => {
    render(<WaitCard rendererProps={recorded("wait: two running tasks and a finished command")} />);
    expect(screen.getByText("2 running · 1 completed")).toBeTruthy();
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.getByText("35% done")).toBeTruthy();
    expect(screen.getByText("60% done")).toBeTruthy();
    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getByText("Check finished with no open items.")).toBeTruthy();
  });

  test("a failed task shows omp's error, and a long one says how much is shown", () => {
    const decoded = decodeWaitDetails(
      sampleNamed("wait: a task that failed, with its error").result.details,
    );
    if (!decoded.ok) throw new Error("the recorded result does not decode");
    const recordedError = decoded.value.jobs?.[0]?.errorText ?? "";
    const { container } = render(
      <WaitCard rendererProps={recorded("wait: a task that failed, with its error")} />,
    );
    expect(screen.getByText("1 failed")).toBeTruthy();
    expect(container.querySelector("[data-slot='t5-jobs']")?.textContent).toContain(
      "Interrupted OpenAI Codex response",
    );
    expect(screen.queryByText(/Showing 500 of/)).toBeNull();
    const longer = alteredResult(
      "wait: a task that failed, with its error",
      ["details", "jobs", 0, "errorText"],
      recordedError.repeat(3),
    );
    cleanup();
    render(<WaitCard rendererProps={longer} />);
    const shown = recordedError.length * 3;
    expect(
      screen.getByText(`Showing 500 of ${shown.toLocaleString("en-US")} characters`),
    ).toBeTruthy();
  });

  test("an interruption says so and shows the text omp returned", () => {
    render(<WaitCard rendererProps={recorded("wait: interrupted by a message")} />);
    expect(screen.getByText("Interrupted by a message")).toBeTruthy();
    expect(screen.getByText("Wait interrupted by message.")).toBeTruthy();
  });

  test("an aborted call shows omp's own words as its reason, not an empty card", () => {
    render(<WaitCard rendererProps={recorded("wait: the call was aborted")} />);
    expect(screen.getByRole("alert").textContent).toContain("Operation aborted");
  });

  test("a job with a status omp does not send is a visible error, not an empty card", () => {
    const props = alteredResult(
      "wait: two running tasks and a finished command",
      ["details", "jobs", 0, "status"],
      "paused",
    );
    render(<WaitCard rendererProps={props} />);
    expect(screen.getByRole("alert").textContent).toContain("Malformed wait");
  });
});

describe("T5.3 hub card on recorded results", () => {
  test("a message sent to one peer names the recipient and the delivery", () => {
    render(<HubCard rendererProps={recorded("hub: a message delivered to one peer")} />);
    expect(screen.getByText("Sent to WriterOne · Delivered")).toBeTruthy();
    expect(screen.getByText("Recipients")).toBeTruthy();
  });

  test("a message that woke an idle peer says the peer was woken", () => {
    render(<HubCard rendererProps={recorded("hub: a message that woke an idle peer")} />);
    expect(screen.getByText("Sent to ResearcherOne · Woke agent")).toBeTruthy();
  });

  test("a cancelled job lists as cancelled", () => {
    render(<HubCard rendererProps={recorded("hub: a background job cancelled")} />);
    expect(screen.getByText("1 cancelled")).toBeTruthy();
    expect(screen.getByText("AuditOne")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
  });

  test("the roster shows each agent and the totals omp reports for all agents", () => {
    render(<HubCard rendererProps={recorded("hub: the agents in the roster")} />);
    expect(screen.getByText("1 running · 5 parked")).toBeTruthy();
    expect(screen.getByText("Agents · 1 running · 5 parked")).toBeTruthy();
    expect(screen.getByText("Started by Main")).toBeTruthy();
  });

  test("a service that failed to start shows its state and exit code", () => {
    render(<HubCard rendererProps={recorded("hub: a service that failed to start")} />);
    expect(screen.getByText("preview-server · Failed")).toBeTruthy();
    expect(screen.getByText("Exit code 1")).toBeTruthy();
  });

  test("a service log shows its lines without terminal colour codes", () => {
    const { container } = render(
      <HubCard rendererProps={recorded("hub: the log of a service that is ready")} />,
    );
    expect(screen.getByText("Log · Ready")).toBeTruthy();
    const log = container.querySelector("[data-slot='t5-hub-log']")?.textContent ?? "";
    expect(log).toContain("Metro waiting on");
    expect(log).not.toContain("\u001b");
    expect(log).not.toContain("[0m");
  });

  test("a failed call shows omp's own words as its reason", () => {
    render(<HubCard rendererProps={recorded("hub: the call failed")} />);
    expect(screen.getByRole("alert").textContent).toContain("Daemon broker client closed");
  });

  test("a recipient outcome omp does not send is a visible error", () => {
    const props = alteredResult(
      "hub: a message delivered to one peer",
      ["details", "receipts", 0, "outcome"],
      "lost",
    );
    render(<HubCard rendererProps={props} />);
    expect(screen.getByRole("alert").textContent).toContain("Malformed hub");
  });
});
