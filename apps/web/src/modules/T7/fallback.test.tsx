import type { ToolCallId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T7ToolFallback } from "./fallback";

function props(result: unknown, toolCallId = "t7-host-1"): ToolRendererProps {
  return {
    toolCallId: toolCallId as ToolCallId,
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
    expandToolCards();
    expect(screen.getByRole("alert").textContent).toContain("Host tools are unavailable.");
    expect(screen.getByTestId("t7-fallback-arguments").textContent).toContain("operation");
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
    expandToolCards();
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

  test("a finished call says its status once in its chip, and its text shows on click", () => {
    const finished = props(
      { content: [{ type: "text", text: "MCP result" }], details: { value: "ok" } },
      "t7-finished",
    );
    render(<T7ToolFallback {...finished} toolName="mcp__notion_search" />);
    expect(screen.getByTestId("tool-state-chip-success").textContent).toContain("Complete");
    expect(screen.queryByText("Finished")).toBeNull();
    const trigger = screen.getByRole("button", { name: "MCP tool: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("MCP result")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("MCP result")).toBeTruthy();
  });

  test("a failed call has no summary line, and its reason shows in an alert", () => {
    const failed: ToolRendererProps = {
      ...props({
        content: [{ type: "text", text: "Tool mcp__notion_search not found" }],
        details: { isError: true, error: "Tool mcp__notion_search not found" },
      }),
      isError: true,
    };
    render(<T7ToolFallback {...failed} toolName="mcp__notion_search" />);
    expandToolCards();
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

describe("T7 fallback, an unclaimed tool", () => {
  test("starts as one line; on click, its arguments and text show with no JSON type words", () => {
    render(
      <T7ToolFallback
        {...props(
          { content: [{ type: "text", text: "custom result text" }], details: {} },
          "t7-unclaimed",
        )}
        args={{ query: "fixture" }}
        toolName="some_unlisted_tool"
      />,
    );
    const trigger = screen.getByRole("button", { name: "some_unlisted_tool: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("t7-fallback-arguments")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByTestId("t7-fallback-arguments").textContent).toContain("Arguments");
    expect(screen.getByText("query")).toBeTruthy();
    expect(screen.getByText("fixture")).toBeTruthy();
    expect(screen.getByText("custom result text")).toBeTruthy();
    expect(screen.queryByText("Arguments: object")).toBeNull();
    expect(screen.queryByText("content: array")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
  });
});

describe("T7 fallback body", () => {
  test("starts as one line, opens to its details on click, and its header folds them away", () => {
    render(
      <T7ToolFallback
        {...props({ content: [{ type: "text", text: "MCP result" }], details: { value: "ok" } })}
        toolCallId={"t7-fold" as ToolCallId}
        toolName="mcp__notion_search"
      />,
    );
    const trigger = screen.getByRole("button", { name: "MCP tool: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("t7-fallback-details")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("t7-fallback-details")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("t7-fallback-details")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId("t7-fallback-details")).toBeTruthy();
  });
});

const PICTURE = "iVBORw0KGgo=";

describe("T7 fallback, a result that holds pictures", () => {
  test("draws the picture below the call and never shows its base64 as text", () => {
    render(
      <T7ToolFallback
        {...props(
          { content: [{ type: "image", data: PICTURE, mimeType: "image/png" }] },
          "t7-picture",
        )}
        toolName="mcp__fixture_show_picture"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "MCP tool: Complete" }));
    const pictures = document.querySelectorAll('[data-slot="tool-result-image"] img');
    expect(pictures.length).toBe(1);
    expect(pictures[0]?.getAttribute("src")).toBe(`data:image/png;base64,${PICTURE}`);
    expect(screen.queryByText(/^Result:/)).toBeNull();
    expect(document.body.textContent).not.toContain(PICTURE);
  });

  test("says in plain words why a picture is not drawn, as the read card does", () => {
    render(
      <T7ToolFallback
        {...props(
          { content: [{ type: "image", data: PICTURE, mimeType: "image/svg+xml" }] },
          "t7-vector",
        )}
        toolName="mcp__fixture_draw_vector"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "MCP tool: Complete" }));
    expect(screen.getByText("This type of image cannot be shown here.")).toBeTruthy();
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.body.textContent).not.toContain(PICTURE);
  });

  test("says how large an oversize picture is, and draws none", () => {
    // 5,592,408 characters of base64 decode to 4,194,305 bytes, one more than the card's cap.
    const overCap = `${"A".repeat(5_592_404)}AAA=`;
    render(
      <T7ToolFallback
        {...props({ content: [{ type: "image", data: overCap, mimeType: "image/png" }] }, "t7-big")}
        toolName="mcp__fixture_show_picture"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "MCP tool: Complete" }));
    expect(
      screen.getByText(
        "This image is 4.0 MB. This card shows images up to 4 MB, so it is not drawn here.",
      ),
    ).toBeTruthy();
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.body.textContent).not.toContain(overCap.slice(0, 64));
  });

  test("keeps the base64 out of the raw details too", () => {
    render(
      <T7ToolFallback
        {...props({ content: [{ type: "image", data: PICTURE, mimeType: "image/png" }] }, "t7-raw")}
        toolName="mcp__fixture_show_picture"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "MCP tool: Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Show raw details" }));
    expect(screen.getByText("[picture data not shown]")).toBeTruthy();
    expect(document.body.textContent).not.toContain(PICTURE);
  });
});
