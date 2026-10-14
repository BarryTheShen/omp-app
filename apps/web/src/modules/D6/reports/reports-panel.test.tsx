import {
  type AbortSignalLike,
  AppFailure,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DiagnosticCommandPort, DiagnosticCommandResult } from "../contract";
import { ReportsPanel } from "./reports-panel";

afterEach(cleanup);

const THREAD: ThreadId = ThreadIdSchema.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

const CHOICES = [
  "Last three releases",
  "Full changelog",
  "Background jobs",
  "Full job command lines",
  "Session trace",
];

function resultOf(text: string): DiagnosticCommandResult {
  return {
    command: "changelog",
    status: "completed",
    lines: [{ text, level: "info", redacted: false }],
    promptSettled: true,
    sessionSettled: true,
    truncated: false,
  };
}

function portWith(run: DiagnosticCommandPort["run"]): DiagnosticCommandPort {
  return { run, cancel: vi.fn() };
}

function renderPanel(port: DiagnosticCommandPort, onOpenChange = vi.fn()) {
  return render(<ReportsPanel onOpenChange={onOpenChange} open port={port} threadId={THREAD} />);
}

describe("the reports panel", () => {
  test("offers the five reports as one group of choices, none pressed at first", () => {
    renderPanel(portWith(vi.fn()));
    expect(
      screen.getByRole("group", { name: "Report choices" }).querySelectorAll("button"),
    ).toHaveLength(5);
    for (const label of CHOICES) {
      expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe(
        "false",
      );
    }
  });

  test("runs the report the person picks, shows omp's words, and presses that choice", async () => {
    const run = vi.fn(async () => resultOf("Release notes for this version"));
    renderPanel(portWith(run));
    fireEvent.click(screen.getByRole("button", { name: "Last three releases" }));
    expect(await screen.findByText("Release notes for this version")).toBeTruthy();
    expect(run).toHaveBeenCalledWith(THREAD, { name: "changelog" }, expect.anything());
    expect(
      screen.getByRole("button", { name: "Last three releases" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("the session trace choice says what it does while it is chosen", async () => {
    renderPanel(portWith(vi.fn(async () => resultOf("http://127.0.0.1:3847/#/traces"))));
    fireEvent.click(screen.getByRole("button", { name: "Session trace" }));
    expect(await screen.findByText(/Starts omp's stats dashboard on this computer/)).toBeTruthy();
    expect(screen.getByText(/contains the path of this session's file/)).toBeTruthy();
  });

  test("closing the panel stops waiting for the report and unpresses its choice", async () => {
    const signals: AbortSignalLike[] = [];
    const run: DiagnosticCommandPort["run"] = (_thread, _request, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise<DiagnosticCommandResult>(() => undefined);
    };
    const onOpenChange = vi.fn();
    renderPanel(portWith(run), onOpenChange);
    fireEvent.click(screen.getByRole("button", { name: "Background jobs" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Close Background jobs" }));
    expect(onOpenChange).toHaveBeenCalledWith(false, "close-button");
    expect(signals[0]?.aborted).toBe(true);
    expect(
      screen.getByRole("button", { name: "Background jobs" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("Try again runs the same report again after a failed run", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new AppFailure({
          code: "omp_error",
          message: "omp stopped responding.",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(resultOf("Background jobs: none running."));
    renderPanel(portWith(run));
    fireEvent.click(screen.getByRole("button", { name: "Background jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Background jobs: none running.")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(THREAD, { name: "jobs" }, expect.anything());
  });
});
