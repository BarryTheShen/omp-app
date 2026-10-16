import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExecutionRecord } from "@/modules/U2/execution";
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

  test("the header has an arrow that screen readers skip, so the card reads as a disclosure", () => {
    const { container } = render(<ExecutionRow record={run} />);
    const arrow = container.querySelector("summary > svg");
    expect(arrow).not.toBeNull();
    expect(arrow?.getAttribute("aria-hidden")).toBe("true");
  });
});
