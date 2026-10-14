import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OverlayControls, OverlayOpenOptions } from "@/overlay/overlay-host";
import type { DiagnosticCommandRequest } from "../contract";
import type { DiagnosticReportRunner, RunOptions } from "../reports/runner";
import { securityActionOf } from "./actions";
import { runSecurityAction } from "./run";

afterEach(cleanup);

const CONTROLS = { id: "test-overlay", close: () => undefined, requestClose: () => undefined };

/** Records the modal the confirmation opens, so the test can render it and press its buttons. */
function recordingOverlay() {
  const opened: OverlayOpenOptions[] = [];
  const overlay = {
    open: (options: OverlayOpenOptions) => {
      opened.push(options);
      return { id: "test-overlay" } as never;
    },
  };
  return { overlay, opened };
}

function runnerRecording() {
  const run = vi.fn(
    async (_request: DiagnosticCommandRequest, _title: string, _options?: RunOptions) => undefined,
  );
  return { runner: { run } as unknown as DiagnosticReportRunner, run };
}

function renderOpenedConfirmation(opened: readonly OverlayOpenOptions[]) {
  const content = opened[0]?.content;
  const node =
    typeof content === "function" ? content(CONTROLS as unknown as OverlayControls) : content;
  render(<div>{node}</div>);
}

describe("runSecurityAction", () => {
  test("a destructive action sends nothing until the person confirms it", async () => {
    const { overlay, opened } = recordingOverlay();
    const { runner, run } = runnerRecording();
    const request: DiagnosticCommandRequest = { name: "security", args: "cancel scan-7" };
    const running = runSecurityAction(overlay, runner, securityActionOf("cancel"), request);
    expect(run).not.toHaveBeenCalled();
    renderOpenedConfirmation(opened);
    expect(screen.getByText("Stop this scan?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop the scan" }));
    await running;
    expect(run).toHaveBeenCalledWith(request, "Security: Cancel a running scan", {
      emptyNote: undefined,
    });
  });

  test("Cancel in the confirmation keeps omp from receiving the action", async () => {
    const { overlay, opened } = recordingOverlay();
    const { runner, run } = runnerRecording();
    const running = runSecurityAction(overlay, runner, securityActionOf("disposition"), {
      name: "security",
      args: "disposition f-1 accepted",
    });
    renderOpenedConfirmation(opened);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await running;
    expect(run).not.toHaveBeenCalled();
  });

  test("a scan asks first, because it spends model budget", async () => {
    const { overlay, opened } = recordingOverlay();
    const { runner, run } = runnerRecording();
    const running = runSecurityAction(overlay, runner, securityActionOf("scan"), {
      name: "security",
      args: "scan",
    });
    expect(run).not.toHaveBeenCalled();
    renderOpenedConfirmation(opened);
    expect(screen.getByText("Start this scan?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start the scan" }));
    await running;
    expect(run).toHaveBeenCalledWith({ name: "security", args: "scan" }, "Security: Start a scan", {
      emptyNote: undefined,
    });
  });

  test("validate asks first, and its run gives the chat note for an answer omp puts in the chat", async () => {
    const { overlay, opened } = recordingOverlay();
    const { runner, run } = runnerRecording();
    const request: DiagnosticCommandRequest = { name: "security", args: "validate scan-1 f-1" };
    const running = runSecurityAction(overlay, runner, securityActionOf("validate"), request);
    expect(run).not.toHaveBeenCalled();
    renderOpenedConfirmation(opened);
    expect(screen.getByText("Check this finding?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check the finding" }));
    await running;
    expect(run).toHaveBeenCalledWith(request, "Security: Validate a finding", {
      emptyNote: "omp is checking this finding in the chat; its answer appears there.",
    });
  });

  test("an action that changes nothing runs straight away, with no confirmation", async () => {
    const { overlay, opened } = recordingOverlay();
    const { runner, run } = runnerRecording();
    await runSecurityAction(overlay, runner, securityActionOf("status"), {
      name: "security",
      args: "status",
    });
    expect(opened).toHaveLength(0);
    expect(run).toHaveBeenCalledWith(
      { name: "security", args: "status" },
      "Security: Show scan status",
      { emptyNote: undefined },
    );
  });
});
