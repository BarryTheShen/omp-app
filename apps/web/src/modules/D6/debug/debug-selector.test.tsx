import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Button } from "@/components/ui/button";
import type { OverlayCloseReason } from "@/overlay/grammar";
import type { OverlayControls, OverlayOpenOptions } from "@/overlay/overlay-host";
import { OverlayHost, useStableOverlayHost } from "@/overlay/overlay-host";
import type { RecoveryAction } from "../contract";
import { DEBUG_DIAGNOSTICS, type DebugDiagnosticId, openDebugSelector } from "./debug-selector";

afterEach(cleanup);

function makeOverlay() {
  const opened: OverlayOpenOptions[] = [];
  const resolveClosed = new Map<string, (reason: OverlayCloseReason) => void>();
  const overlay = {
    open: vi.fn((request: OverlayOpenOptions) => {
      const id = `overlay-${opened.length + 1}`;
      let resolve!: (reason: OverlayCloseReason) => void;
      const closed = new Promise<OverlayCloseReason>((complete) => {
        resolve = complete;
      });
      resolveClosed.set(id, resolve);
      opened.push(request);
      return { id, closed };
    }),
  };
  const controlsFor = (id: string): OverlayControls => ({
    id,
    close: vi.fn((reason: OverlayCloseReason = "programmatic") => resolveClosed.get(id)?.(reason)),
    requestClose: vi.fn(),
    update: vi.fn(),
  });
  return { opened, overlay, controlsFor };
}

function setup(options: Parameters<typeof openDebugSelector>[1] = {}) {
  const state = makeOverlay();
  openDebugSelector(state.overlay, options);
  const first = state.opened[0];
  if (!first || typeof first.content !== "function")
    throw new Error("The picker overlay did not open.");
  const controls = state.controlsFor("overlay-1");
  render(first.content(controls));
  return { ...state, controls };
}

const recentLogs = DEBUG_DIAGNOSTICS.find((choice) => choice.id === "logs");
if (!recentLogs) throw new Error("The recent logs diagnostic is missing.");
const availableDiagnostic = {
  ...recentLogs,
  availability: { state: "available" as const },
};

const unavailableAction: RecoveryAction = {
  id: "clear-artifact-cache",
  kind: "clear-local",
  label: "Clear artifact cache",
  availability: { state: "unavailable", reason: "The app cannot clear omp's private files." },
};

const clearAction: RecoveryAction = {
  id: "clear-artifact-cache",
  kind: "clear-local",
  label: "Clear artifact cache",
  availability: { state: "available" },
};

const reconnectAction: RecoveryAction = {
  id: "reconnect",
  kind: "reconnect",
  label: "Reconnect",
  availability: { state: "available" },
};

function LiveRecoveryHarness({
  actions,
  onRecoveryAction,
}: {
  readonly actions: readonly RecoveryAction[];
  readonly onRecoveryAction: (action: RecoveryAction) => void | Promise<void>;
}) {
  const overlay = useStableOverlayHost();
  return (
    <Button
      onClick={() => openDebugSelector(overlay, { recoveryActions: actions, onRecoveryAction })}
      type="button"
    >
      Open the picker
    </Button>
  );
}

function LiveDiagnosticHarness({
  choice,
  onChoose,
}: {
  readonly choice: typeof availableDiagnostic;
  readonly onChoose: (id: DebugDiagnosticId) => void | Promise<void>;
}) {
  const overlay = useStableOverlayHost();
  return (
    <Button
      onClick={() => openDebugSelector(overlay, { choices: [choice], onChoose })}
      type="button"
    >
      Open the diagnostic picker
    </Button>
  );
}

describe("the debug selector", () => {
  test("lists each diagnostic once with its own shared-row description", () => {
    const { opened } = setup();

    expect(opened[0]).toMatchObject({ kind: "modal", focus: "move", label: "Debug tools" });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(DEBUG_DIAGNOSTICS.length);
    expect(options[0]?.textContent).toContain("Recent logs");
    expect(options[0]?.textContent).toContain("View the latest diagnostic log entries.");
    expect(screen.queryByText(/available in omp's terminal, not in the app/)).toBeNull();
  });

  test("an unavailable notice stays inside the focus-managed picker", () => {
    const { opened } = setup();

    fireEvent.click(screen.getByRole("option", { name: /^Transcript/ }));
    expect(opened).toHaveLength(1);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "This diagnostic is available in omp's terminal, not in the app.",
    );
    const dismiss = screen.getByRole("button", { name: "Dismiss notice" });
    expect(document.activeElement).toBe(dismiss);
    expect(screen.getByRole("heading", { name: "Diagnostics" })).toBeTruthy();
    fireEvent.click(dismiss);
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /^Transcript/ }));
  });

  test("an available diagnostic runs once, shows pending work and closes on success", async () => {
    let resolveChoose: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveChoose = resolve;
    });
    const onChoose = vi.fn(() => pending);
    const { controls } = setup({ choices: [availableDiagnostic], onChoose });

    fireEvent.click(screen.getByRole("option", { name: /^Recent logs/ }));
    expect(onChoose).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledWith("logs");
    expect(screen.getByText("Working…")).toBeTruthy();

    resolveChoose?.();
    await waitFor(() => expect(controls.close).toHaveBeenCalledWith("programmatic"));
    expect(controls.close).toHaveBeenCalledOnce();
  });

  test("an available diagnostic without a handler announces the fallback in the picker", () => {
    const { opened } = setup({ choices: [availableDiagnostic] });

    fireEvent.click(screen.getByRole("option", { name: /^Recent logs/ }));
    expect(opened).toHaveLength(1);
    expect(screen.getByTestId("dialog-frame")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("This diagnostic is not connected.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss notice" }));
  });

  test("a rejected diagnostic reports a redacted error in the still-open picker", async () => {
    const onChoose = vi.fn(async () => {
      throw new Error("Could not open /home/person/x.log");
    });
    setup({ choices: [availableDiagnostic], onChoose });

    fireEvent.click(screen.getByRole("option", { name: /^Recent logs/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("<REDACTED:PATH>"));
    expect(screen.getByRole("heading", { name: "Diagnostic unavailable" })).toBeTruthy();
    expect(screen.getByTestId("dialog-frame")).toBeTruthy();
    expect(screen.queryByText("/home/person/x.log")).toBeNull();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  test("unavailable recovery actions reveal their complete reason without running", () => {
    const onRecoveryAction = vi.fn();
    setup({ recoveryActions: [unavailableAction], onRecoveryAction });

    expect(
      screen
        .getByRole("button", { name: /Clear artifact cache Unavailable/ })
        .getAttribute("disabled"),
    ).not.toBeNull();
    const why = screen.getByRole("button", { name: "Why unavailable" });
    fireEvent.click(why);
    expect(screen.getByRole("status").textContent).toContain("cannot clear omp's private files");
    expect(onRecoveryAction).not.toHaveBeenCalled();
    const dismiss = screen.getByRole("button", { name: "Dismiss notice" });
    expect(document.activeElement).toBe(dismiss);
    fireEvent.click(dismiss);
    expect(document.activeElement).toBe(why);
  });

  test("asks for local cleanup in the same real U0 overlay and shows the result", async () => {
    const onRecoveryAction = vi.fn();
    render(
      <OverlayHost>
        <LiveRecoveryHarness actions={[clearAction]} onRecoveryAction={onRecoveryAction} />
      </OverlayHost>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open the picker" }));
    const action = screen.getByRole("button", { name: "Clear artifact cache" });
    fireEvent.click(action);
    expect(screen.getByRole("heading", { name: "Clear saved diagnostic data?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear saved data" })).toBeTruthy();
    expect(onRecoveryAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep data" }));
    expect(document.activeElement).toBe(action);
    expect(onRecoveryAction).not.toHaveBeenCalled();

    fireEvent.click(action);
    fireEvent.click(screen.getByRole("button", { name: "Clear saved data" }));
    await waitFor(() => expect(onRecoveryAction).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toContain("recovery action is complete");
  });

  test("a late failed recovery still opens a focus-managed error after the picker closes", async () => {
    let rejectRecovery: ((error: Error) => void) | undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    const onRecoveryAction = vi.fn(() => pending);
    render(
      <OverlayHost>
        <LiveRecoveryHarness actions={[reconnectAction]} onRecoveryAction={onRecoveryAction} />
      </OverlayHost>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open the picker" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(screen.getByText("Working…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rejectRecovery?.(new Error("Could not connect to /home/person/private.log"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("<REDACTED:PATH>"));
    expect(screen.queryByText("/home/person/private.log")).toBeNull();
  });

  test("a diagnostic rejection after picker dismissal opens a focus-managed notice", async () => {
    let rejectChoose: ((error: Error) => void) | undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectChoose = reject;
    });
    const onChoose = vi.fn(() => pending);
    render(
      <OverlayHost>
        <LiveDiagnosticHarness choice={availableDiagnostic} onChoose={onChoose} />
      </OverlayHost>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open the diagnostic picker" }));
    fireEvent.click(screen.getByRole("option", { name: /^Recent logs/ }));
    expect(screen.getByText("Working…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Debug tools" })).toBeNull());

    rejectChoose?.(new Error("Could not open /home/person/x.log"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("<REDACTED:PATH>"));
    expect(screen.getByRole("heading", { name: "Diagnostic unavailable" })).toBeTruthy();
    expect(screen.queryByText("/home/person/x.log")).toBeNull();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  test("shows a fixed validation error instead of schema diagnostics", async () => {
    const invalid = { ...reconnectAction, extra: true } as RecoveryAction;
    const { opened } = setup({ recoveryActions: [invalid], onRecoveryAction: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("could not be validated"),
    );
    expect(opened).toHaveLength(1);
    expect(screen.queryByText(/Expected|received|Zod/)).toBeNull();
  });
});
