import { AppFailure, type ThreadId, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay/overlay-host";
import type { DiagnosticCommandPort, DiagnosticCommandResult } from "../contract";
import { SecurityReportPanel } from "./security-panel-container";

afterEach(cleanup);

const THREAD: ThreadId = ThreadIdSchema.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

function resultOf(lines: readonly string[]): DiagnosticCommandResult {
  return {
    command: "security",
    status: "completed",
    lines: lines.map((text) => ({ text, level: "info", redacted: false })),
    promptSettled: true,
    sessionSettled: true,
    truncated: false,
  };
}

function portWith(run: DiagnosticCommandPort["run"]): DiagnosticCommandPort {
  return { run, cancel: vi.fn() };
}

function renderPanel(port: DiagnosticCommandPort) {
  return render(
    <OverlayHost>
      <SecurityReportPanel onOpenChange={vi.fn()} open port={port} threadId={THREAD} />
    </OverlayHost>,
  );
}

/** Picks an action in the picker and, when given, types its details. */
function pick(action: string, details?: string) {
  fireEvent.change(screen.getByLabelText("Security action"), { target: { value: action } });
  if (details !== undefined) {
    fireEvent.change(screen.getByLabelText(/^Details/), { target: { value: details } });
  }
}

describe("the security panel", () => {
  test("shows what to type for the chosen action, in plain words", () => {
    renderPanel(portWith(vi.fn()));
    pick("cancel");
    expect(
      screen.getByText("The operation id of the scan to stop. Show scan status lists them."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Details (required)").getAttribute("placeholder")).toBe(
      "Operation id",
    );
  });

  test("plan takes optional options in a box that names them, and runs with the ones typed", () => {
    const run = vi.fn<DiagnosticCommandPort["run"]>(async () => resultOf(["Plan ready."]));
    renderPanel(portWith(run));
    pick("plan");
    expect(screen.getByLabelText("Details (optional)").getAttribute("placeholder")).toBe(
      "Options (optional), such as --path src",
    );
    expect(screen.getByText(/Leave this empty to plan the whole project/)).toBeTruthy();
    pick("plan", "--path src");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(run.mock.calls[0]?.[1]).toEqual({ name: "security", args: "plan --path src" });
  });

  test("Start the scan and Check the finding are default buttons, since they spend budget and destroy nothing", async () => {
    const run = vi.fn<DiagnosticCommandPort["run"]>(async () => resultOf(["Done."]));
    renderPanel(portWith(run));
    pick("scan");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const start = await screen.findByRole("button", { name: "Start the scan" });
    expect(start.className).toContain("bg-primary");
    expect(start.className).not.toContain("bg-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    pick("validate", "scan-1 f-1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const check = await screen.findByRole("button", { name: "Check the finding" });
    expect(check.className).toContain("bg-primary");
    expect(check.className).not.toContain("bg-destructive");
    expect(run).not.toHaveBeenCalled();
  });

  test("an empty required field sends nothing and opens no dialog", () => {
    const run = vi.fn();
    renderPanel(portWith(run));
    pick("cancel");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByText("Type the details this action needs.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  test("a cancel asks first, then sends omp's command with the operation id", async () => {
    const run = vi.fn(async () => resultOf(["Cancellation requested for op-1."]));
    renderPanel(portWith(run));
    pick("cancel", "op-1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop the scan" }));
    expect(await screen.findByText("Cancellation requested for op-1.")).toBeTruthy();
    expect(run).toHaveBeenCalledWith(
      THREAD,
      { name: "security", args: "cancel op-1" },
      expect.anything(),
    );
  });

  test("validate says omp answers in the chat when it prints no text here", async () => {
    const run = vi.fn(async () => resultOf([]));
    renderPanel(portWith(run));
    pick("validate", "scan-1 f-1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check the finding" }));
    expect(
      await screen.findByText(
        "omp is checking this finding in the chat; its answer appears there.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("omp sent no text for this report.")).toBeNull();
  });

  test("Try again runs the last action again", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new AppFailure({
          code: "omp_error",
          message: "omp stopped responding.",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(resultOf(["Scan status: idle."]));
    renderPanel(portWith(run));
    pick("status");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Scan status: idle.")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(
      THREAD,
      { name: "security", args: "status" },
      expect.anything(),
    );
  });
});
