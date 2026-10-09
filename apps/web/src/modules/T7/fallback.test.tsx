import type { ToolCallId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T7ToolFallback } from "./fallback";

function props(result: unknown): ToolRendererProps {
  return {
    toolCallId: "t7-host-1" as ToolCallId,
    toolName: "host_tool",
    args: { operation: "read", path: "/private/example", requestId: "redacted" },
    argsText: '{"operation":"read"}',
    result,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

afterEach(() => cleanup());

describe("T7 fallback", () => {
  test("renders host correlation, unavailable reason, and collapsible typed trees", () => {
    render(
      <T7ToolFallback
        {...props({
          status: "unavailable",
          capability: "omp.host-tools",
          available: false,
          reason: "Host tools are unavailable.",
          result: { long: "x".repeat(300) },
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Host tools are unavailable.");
    expect(screen.getByText("Arguments: object")).toBeTruthy();
    expect(screen.getByText("Result: object")).toBeTruthy();
    expect(screen.getByText(/long string/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show raw details" })).toBeTruthy();
  });

  test("maps host cancellation without executing or exposing raw error text in summary", () => {
    render(
      <T7ToolFallback
        {...props({ status: "cancelled", error: { code: "permission", message: "secret" } })}
      />,
    );
    expect(screen.getAllByText("Host tool: cancelled").length).toBeGreaterThan(0);
    expect(screen.getByTestId("tool-state-chip-cancelled").textContent).toContain("Cancelled");
    expect(screen.getByTestId("t7-fallback-details")).toBeTruthy();
  });

  test("labels omp's MCP tool names as MCP tools", () => {
    render(
      <T7ToolFallback
        {...props({
          content: [{ type: "text", text: "MCP result" }],
          details: { value: "ok" },
        })}
        toolName="mcp__notion_search"
      />,
    );
    expect(screen.getByRole("button", { name: "MCP tool: Complete" })).toBeTruthy();
  });

  test("labels omp's xd__mcp__ tool names as MCP tools too", () => {
    render(
      <T7ToolFallback
        {...props({
          content: [{ type: "text", text: "MCP result" }],
          details: { value: "ok" },
        })}
        toolName="xd__mcp__notion_search"
      />,
    );
    expect(screen.getByRole("button", { name: "MCP tool: Complete" })).toBeTruthy();
  });

  test("a finished result is summarised as Finished, and a failed call has no summary", () => {
    const finished = props({
      content: [{ type: "text", text: "MCP result" }],
      details: { value: "ok" },
    });
    const { unmount } = render(<T7ToolFallback {...finished} toolName="mcp__notion_search" />);
    expect(screen.getByText("Finished")).toBeTruthy();
    unmount();
    const failed: ToolRendererProps = {
      ...props({
        content: [{ type: "text", text: "Tool mcp__notion_search not found" }],
        details: { isError: true, error: "Tool mcp__notion_search not found" },
      }),
      isError: true,
    };
    render(<T7ToolFallback {...failed} toolName="mcp__notion_search" />);
    expect(screen.queryByText("Recorded tool result")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes("Tool mcp__notion_search not found") === true),
    ).toBe(true);
  });
});

describe("T7 fallback for a finished call with no result", () => {
  test("reads as finished and says no result was recorded, never Streaming", () => {
    render(<T7ToolFallback {...{ ...props(undefined), toolName: "yield" }} />);
    expect(screen.getByTestId("tool-state-chip-unrecorded").textContent).toContain("Finished");
    expect(screen.getAllByText("No result recorded").length).toBeGreaterThan(0);
    expect(screen.queryByText("Streaming")).toBeNull();
  });
});

describe("T7 fallback body", () => {
  test("opens at first sight with its details, and its header folds them away", () => {
    render(
      <T7ToolFallback
        {...props({ content: [{ type: "text", text: "MCP result" }], details: { value: "ok" } })}
        toolCallId={"t7-fold" as ToolCallId}
        toolName="mcp__notion_search"
      />,
    );
    const trigger = screen.getByRole("button", { name: "MCP tool: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("t7-fallback-details")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("t7-fallback-details")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId("t7-fallback-details")).toBeTruthy();
  });
});
