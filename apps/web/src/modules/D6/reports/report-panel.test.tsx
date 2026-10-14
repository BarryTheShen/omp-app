import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RedactedReportLine } from "../contract";
import { DiagnosticReportPanel, ReportBody, reportPanelState } from "./report-panel";
import { IDLE_REPORT, type ReportSnapshot } from "./runner";

afterEach(cleanup);

const CANCELLED = "The command was cancelled before it finished.";

function snapshotOf(overrides: Partial<ReportSnapshot>): ReportSnapshot {
  return { ...IDLE_REPORT, title: "Changelog", ...overrides };
}

function line(text: string, redacted = false): RedactedReportLine {
  return { text, level: "info", redacted };
}

describe("the report body in each state", () => {
  test("shows omp's words in a labelled, scrollable block with a copy control", () => {
    render(
      <ReportBody
        snapshot={snapshotOf({ status: "ready", lines: [line("# Changelog"), line("- one")] })}
      />,
    );
    expect(screen.getByLabelText("Changelog text").textContent).toBe("# Changelog\n- one");
    expect(screen.getByRole("button", { name: "Copy report" })).toBeTruthy();
  });

  test("copies the report text and says that it did", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ReportBody snapshot={snapshotOf({ status: "ready", lines: [line("a"), line("b")] })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(screen.getByText("Report copied.")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("a\nb");
  });

  test("the copy note does not carry over to a different report", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { rerender } = render(
      <ReportBody snapshot={snapshotOf({ status: "ready", lines: [line("a")] })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(screen.getByText("Report copied.")).toBeTruthy());
    rerender(<ReportBody snapshot={snapshotOf({ status: "ready", lines: [line("b")] })} />);
    expect(screen.queryByText("Report copied.")).toBeNull();
  });

  test("says a copy failed and tells the person how to copy by hand", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ReportBody snapshot={snapshotOf({ status: "ready", lines: [line("a")] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() =>
      expect(
        screen.getByText("Could not copy the report. Select the text and copy it by hand."),
      ).toBeTruthy(),
    );
  });

  test("says which details were hidden and which text was cut", () => {
    render(
      <ReportBody
        snapshot={snapshotOf({
          status: "ready",
          truncated: true,
          lines: [line("ran from <REDACTED:PATH>", true)],
        })}
      />,
    );
    expect(screen.getByText("Some of this report was cut short.")).toBeTruthy();
    expect(
      screen.getByText("Some details were hidden: paths, keys and email addresses."),
    ).toBeTruthy();
  });

  test("offers a retry for a failed report, with its reason shown once", () => {
    const onRetry = vi.fn();
    render(
      <DiagnosticReportPanel
        fallbackTitle="Reports"
        onOpenChange={() => undefined}
        onRetry={onRetry}
        open
        snapshot={snapshotOf({ status: "error", message: "omp stopped responding." })}
      />,
    );
    expect(screen.getAllByText("omp stopped responding.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("a cancelled run keeps the lines omp printed and gives its reason once", () => {
    render(
      <ReportBody
        snapshot={snapshotOf({
          status: "ready",
          aborted: true,
          message: CANCELLED,
          lines: [line("first line")],
        })}
      />,
    );
    expect(screen.getByText("first line")).toBeTruthy();
    expect(screen.getAllByText(CANCELLED)).toHaveLength(1);
  });

  test("a cancelled run with no lines gives its reason once", () => {
    render(
      <DiagnosticReportPanel
        fallbackTitle="Reports"
        onOpenChange={() => undefined}
        open
        snapshot={snapshotOf({ status: "error", aborted: true, message: CANCELLED })}
      />,
    );
    expect(screen.getAllByText(CANCELLED)).toHaveLength(1);
  });

  test("says a report omp printed nothing for is empty", () => {
    render(<ReportBody snapshot={snapshotOf({ status: "empty" })} />);
    expect(screen.getByText("omp sent no text for this report.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy report" })).toBeNull();
  });

  test("says what omp did for a report with no text when its run was given a note", () => {
    render(
      <ReportBody
        snapshot={snapshotOf({
          status: "empty",
          note: "omp is checking this finding in the chat; its answer appears there.",
        })}
      />,
    );
    expect(
      screen.getByText("omp is checking this finding in the chat; its answer appears there."),
    ).toBeTruthy();
    expect(screen.queryByText("omp sent no text for this report.")).toBeNull();
  });

  test("says a report is unavailable with omp's reason, once, and never with the word capability", () => {
    render(
      <DiagnosticReportPanel
        fallbackTitle="Reports"
        onOpenChange={() => undefined}
        open
        snapshot={snapshotOf({
          status: "unavailable",
          message: "The command gateway is unavailable.",
        })}
      />,
    );
    expect(screen.getAllByText("The command gateway is unavailable.")).toHaveLength(1);
    expect(screen.queryByText(/capability/i)).toBeNull();
  });

  test("asks for a choice before any report runs", () => {
    render(<ReportBody snapshot={IDLE_REPORT} />);
    expect(screen.getByText("No report open")).toBeTruthy();
  });
});

describe("the panel state for a report", () => {
  test("follows the report's lifecycle and is read-only", () => {
    expect(reportPanelState(snapshotOf({ status: "loading" }), true, "Reports")).toMatchObject({
      lifecycle: "loading",
      readOnly: true,
      title: "Changelog",
    });
    expect(reportPanelState(IDLE_REPORT, true, "Reports")).toMatchObject({
      lifecycle: "empty",
      title: "Reports",
    });
  });
});
