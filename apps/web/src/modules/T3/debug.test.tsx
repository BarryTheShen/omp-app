import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { DebugCard } from "./debug";
import { T3_SCRIPTED_DEBUG_SESSIONS_RESULT } from "./fixtures/scripted";

afterEach(cleanup);

function props(
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "debug-1",
    toolName: "debug",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

const stoppedSnapshot = {
  id: "session-1",
  adapter: "js-debug-adapter",
  cwd: "/repo",
  program: "app",
  status: "stopped",
  stopReason: "breakpoint",
  frameName: "main",
  source: { path: "src/main.ts" },
  line: 42,
  column: 3,
  needsConfigurationDone: false,
};

function frames(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `frame${index + 1}`,
    source: { path: "src/main.ts" },
    line: 40 + index,
    column: 1,
  }));
}

describe("DebugCard", () => {
  test("shows a stopped session, a bounded stack and variables from result.details", () => {
    render(
      <DebugCard
        rendererProps={props(
          { action: "stack_trace" },
          {
            content: [{ type: "text", text: "Stack trace:\n- #1 frame1 @ src/main.ts:40:1" }],
            details: {
              action: "stack_trace",
              success: true,
              snapshot: stoppedSnapshot,
              stackFrames: frames(9),
              variables: Array.from({ length: 10 }, (_, index) => ({
                name: `v${index + 1}`,
                value: String(index + 1),
                type: "number",
                variablesReference: 0,
              })),
              threads: [{ id: 1, name: "main" }],
            },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Stack trace")).toBeTruthy();
    expect(screen.getByTestId("t3-debug-snapshot").textContent).toBe(
      "Stopped at src/main.ts:42 · breakpoint",
    );
    expect(screen.getByText("frame6")).toBeTruthy();
    expect(screen.queryByText("frame7")).toBeNull();
    expect(screen.getByText("Showing 6 of 9")).toBeTruthy();
    expect(screen.getByText("v8 = 8")).toBeTruthy();
    expect(screen.queryByText("v9 = 9")).toBeNull();
    expect(screen.getByText("Showing 8 of 10")).toBeTruthy();
    expect(screen.queryByTestId("t3-debug-threads")).toBeNull();
    expect(screen.queryByTestId("t3-debug-text")).toBeNull();
  });

  test("lists threads only when there is more than one", () => {
    render(
      <DebugCard
        rendererProps={props(
          { action: "threads" },
          {
            content: [{ type: "text", text: "Threads:\n- 1: main\n- 2: worker" }],
            details: {
              action: "threads",
              success: true,
              threads: [
                { id: 1, name: "main" },
                { id: 2, name: "worker" },
              ],
            },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("t3-debug-threads").textContent).toContain("worker");
  });
  test("renders all available fields from structured debug sessions", () => {
    render(
      <DebugCard
        rendererProps={props({ action: "sessions" }, T3_SCRIPTED_DEBUG_SESSIONS_RESULT)}
      />,
    );
    expandToolCards();

    const sessions = screen.getByTestId("t3-debug-sessions");
    expect(sessions.textContent).toContain("debug-session-1");
    expect(sessions.textContent).toContain("stopped");
    expect(sessions.textContent).toContain("Adapter: js-debug-adapter");
    expect(sessions.textContent).toContain("Folder: <WORKSPACE>");
    expect(sessions.textContent).toContain("Program: <WORKSPACE>/apps/web/server.ts");
    expect(sessions.textContent).toContain("debug-session-2");
    expect(sessions.textContent).toContain("running");
    expect(screen.queryByTestId("t3-debug-text")).toBeNull();
    expect(screen.queryByText("Debug results aren't available.")).toBeNull();
  });

  test("lists at most eight sessions and says how many there are", () => {
    const sessions = Array.from({ length: 9 }, (_, index) => ({
      id: `debug-session-${index + 1}`,
      adapter: "js-debug-adapter",
      cwd: "<WORKSPACE>",
      program: "<WORKSPACE>/apps/web/server.ts",
      status: "stopped",
    }));
    render(
      <DebugCard
        rendererProps={props(
          { action: "sessions" },
          {
            content: [{ type: "text", text: "9 debug sessions" }],
            details: { action: "sessions", success: true, sessions },
          },
        )}
      />,
    );
    expandToolCards();

    const list = screen.getByTestId("t3-debug-sessions");
    expect(list.textContent).toContain("Session debug-session-8");
    expect(list.textContent).not.toContain("Session debug-session-9");
    expect(list.textContent).toContain("Showing 8 of 9");
  });

  test("uses plain words for the header", () => {
    render(
      <DebugCard
        rendererProps={props(
          { action: "set_breakpoint", file: "src/main.ts", line: 42 },
          {
            content: [{ type: "text", text: "Breakpoints for src/main.ts:\n- line 42: verified" }],
            details: {
              action: "set_breakpoint",
              success: true,
              breakpoints: [{ id: 1, verified: true, line: 42 }],
            },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Breakpoint at src/main.ts:42")).toBeTruthy();
    expect(screen.getByTestId("t3-debug-breakpoints").textContent).toContain("verified");
    cleanup();
    render(
      <DebugCard
        rendererProps={props(
          { action: "evaluate", expression: "counter + 1" },
          {
            content: [{ type: "text", text: "Result: 4\nType: number" }],
            details: {
              action: "evaluate",
              success: true,
              evaluation: { result: "4", type: "number", variablesReference: 0 },
            },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Evaluate counter + 1")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("number")).toBeTruthy();
  });

  test("shows omp's text for actions without structured rows", () => {
    render(
      <DebugCard
        rendererProps={props(
          { action: "scopes" },
          {
            content: [{ type: "text", text: "Scopes:\n- Locals: ref=7, expensive=no" }],
            details: { action: "scopes", success: true, scopes: [{ name: "Locals" }] },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("t3-debug-text").textContent).toContain("Locals: ref=7");
  });

  test("a failed call shows only the card's error banner", () => {
    render(
      <DebugCard
        rendererProps={props(
          { action: "launch", program: "app" },
          { content: [{ type: "text", text: "No debugger adapter available." }] },
          {
            type: "incomplete",
            reason: "error",
            error: {
              code: "internal",
              message: "No debugger adapter available.",
              retryable: false,
            },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Launch app")).toBeTruthy();
    expect(screen.getByTestId("tool-card-debug-1").getAttribute("data-phase")).toBe("error");
    expect(screen.queryByText("Debug results aren't available.")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("No debugger adapter available.");
    expect(screen.queryByText(/upstream/)).toBeNull();
  });

  test("shows one muted line for malformed details", () => {
    render(
      <DebugCard
        rendererProps={props(
          { action: "stack_trace" },
          { content: [], details: { stackFrames: [{ file: "src/main.ts" }] } },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Debug results aren't available.")).toBeTruthy();
    expect(
      screen.queryByText(/"stackFrames"/, { ignore: "[data-slot='u3-tool-card-raw'] *" }),
    ).toBeNull();
  });

  test("running state shows the action from the arguments only", () => {
    render(
      <DebugCard rendererProps={props({ action: "step_over" }, undefined, { type: "running" })} />,
    );
    expandToolCards();
    expect(screen.getByText("Step over")).toBeTruthy();
    expect(screen.getByTestId("tool-card-debug-1").getAttribute("data-phase")).toBe("running");
    expect(screen.queryByText("Debug results aren't available.")).toBeNull();
  });
});
