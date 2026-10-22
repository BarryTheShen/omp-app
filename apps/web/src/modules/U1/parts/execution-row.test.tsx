import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExecutionRecord } from "@/modules/U2/execution";
import { CommandCancelContext } from "../thread/turn-cancel";
import { ExecutionRow } from "./execution-row";

const originalResizeObserver = globalThis.ResizeObserver;
let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    readonly #callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
      resizeCallbacks.push(() => this.#callback([], this as unknown as ResizeObserver));
    }

    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = originalResizeObserver;
});

const run: ExecutionRecord = {
  id: "entry:thread:bash",
  mode: "bash",
  source: "ls /missing",
  output: "ls: cannot access '/missing': No such file or directory\n",
  cancelled: false,
  truncated: false,
  exitCode: 2,
  excludeFromContext: false,
};

describe("U1 execution row", () => {
  test("shows the command, its output, and how it ended", () => {
    render(<ExecutionRow record={run} />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("Exit code 2")).toBeTruthy();
    expect(screen.getByText("ls /missing")).toBeTruthy();
    expect(screen.getByTestId("u1-execution-output").textContent).toContain(
      "No such file or directory",
    );
    expect(screen.queryByText("Not sent to the model")).toBeNull();
  });

  test("marks a run kept out of the model, and says when the command was cancelled", () => {
    render(
      <ExecutionRow record={{ ...run, cancelled: true, excludeFromContext: true, output: "" }} />,
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Not sent to the model")).toBeTruthy();
    expect(screen.queryByTestId("u1-execution-output")).toBeNull();
  });

  test("short command and output blocks are groups without keyboard stops", () => {
    render(<ExecutionRow record={run} />);
    const command = screen.getByRole("group", { name: "Command" });
    const output = screen.getByRole("group", { name: "Output" });
    expect(screen.queryByRole("region", { name: "Command" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Output" })).toBeNull();
    expect(command.getAttribute("tabindex")).toBeNull();
    expect(output.getAttribute("tabindex")).toBeNull();
  });
  test("measures both groups and updates their tab stops after resize", () => {
    render(<ExecutionRow record={run} />);
    const command = screen.getByRole("group", { name: "Command" });
    const output = screen.getByRole("group", { name: "Output" });

    Object.defineProperties(command, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
    });
    Object.defineProperties(output, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
    });
    act(() => {
      resizeCallbacks.forEach((resize) => {
        resize();
      });
    });
    expect(command.getAttribute("tabindex")).toBe("0");
    expect(output.getAttribute("tabindex")).toBeNull();

    Object.defineProperty(command, "scrollHeight", { configurable: true, value: 100 });
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 200 });
    act(() => {
      resizeCallbacks.forEach((resize) => {
        resize();
      });
    });
    expect(command.getAttribute("tabindex")).toBeNull();
    expect(output.getAttribute("tabindex")).toBe("0");
  });

  test("an output that appears after its row is measured, so an overflowing one takes its tab stop", () => {
    const { rerender } = render(<ExecutionRow record={{ ...run, output: "" }} state="running" />);
    expect(screen.queryByRole("group", { name: "Output" })).toBeNull();

    rerender(<ExecutionRow record={run} state="ended" />);
    const output = screen.getByRole("group", { name: "Output" });
    Object.defineProperties(output, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
    });
    act(() => {
      for (const resize of resizeCallbacks) resize();
    });
    expect(output.getAttribute("tabindex")).toBe("0");
  });

  test("the header has an arrow that screen readers skip, so the card reads as a disclosure", () => {
    const { container } = render(<ExecutionRow record={run} />);
    const arrow = container.querySelector("summary > svg");
    expect(arrow).not.toBeNull();
    expect(arrow?.getAttribute("aria-hidden")).toBe("true");
  });

  test("a running command says Running and its Stop command button stops it", () => {
    const cancel = vi.fn(async () => undefined);
    render(
      <CommandCancelContext.Provider value={cancel}>
        <ExecutionRow record={{ ...run, output: "", exitCode: undefined }} state="running" />
      </CommandCancelContext.Provider>,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop command" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("a finished command offers no Stop command, and a running one with no stop to give offers none", () => {
    const { unmount } = render(
      <CommandCancelContext.Provider value={vi.fn(async () => undefined)}>
        <ExecutionRow record={run} />
      </CommandCancelContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Stop command" })).toBeNull();
    unmount();
    render(<ExecutionRow record={{ ...run, output: "", exitCode: undefined }} state="running" />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop command" })).toBeNull();
  });

  test("an ended command with no answer from omp says Ended, and offers no Stop command", () => {
    render(
      <CommandCancelContext.Provider value={vi.fn(async () => undefined)}>
        <ExecutionRow record={{ ...run, output: "", exitCode: undefined }} state="ended" />
      </CommandCancelContext.Provider>,
    );
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop command" })).toBeNull();
  });
});
