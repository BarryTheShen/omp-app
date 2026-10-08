import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { ResolveCard } from "./resolve";

afterEach(cleanup);

function props(
  toolName: "resolve" | "reject",
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `${toolName}-1`,
    toolName,
    args: { action: toolName === "resolve" ? "apply" : "discard" },
    argsText: JSON.stringify({ action: toolName }),
    result,
    status,
  } as unknown as ToolRendererProps;
}

describe("ResolveCard", () => {
  test("renders pending staged action and source/reason", () => {
    render(
      <ResolveCard
        rendererProps={props(
          "resolve",
          { action: "apply", reason: "Approve device access", sourceToolName: "host_tool" },
          { type: "running" },
        )}
      />,
    );
    const card = screen.getByTestId("t7-resolve-status-resolve-1");
    expect(card.getAttribute("data-status")).toBe("pending");
    expect(card.textContent).toContain("Pending decision");
    expect(card.textContent).toContain("host_tool");
    expect(card.textContent).toContain("Approve device access");
  });

  test("renders approved resolve and rejected reject with status tones", () => {
    render(
      <>
        <ResolveCard
          rendererProps={props("resolve", { action: "apply", reason: "Accepted", label: "URI" })}
        />
        <ResolveCard
          rendererProps={props("reject", { action: "discard", reason: "Denied", label: "URI" })}
        />
      </>,
    );
    expect(screen.getByTestId("t7-resolve-status-resolve-1").getAttribute("data-status")).toBe(
      "approved",
    );
    expect(screen.getByTestId("t7-resolve-status-reject-1").getAttribute("data-status")).toBe(
      "rejected",
    );
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  test("failed result never reads as accepted and malformed details stay visible", () => {
    render(
      <ResolveCard
        rendererProps={props(
          "resolve",
          { unexpected: true },
          { type: "incomplete", reason: "error" },
        )}
      />,
    );
    expect(screen.getByTestId("t7-resolve-status-resolve-1").getAttribute("data-status")).toBe(
      "rejected",
    );
    expect(
      screen.getAllByRole("alert").some((item) => item.textContent?.includes("not accepted")),
    ).toBe(true);
  });
});

describe("ResolveCard with no result recorded", () => {
  test("says no result was recorded and never reports an approval nobody gave", () => {
    render(<ResolveCard rendererProps={props("resolve", undefined)} />);
    expect(screen.getAllByText("No result recorded").length).toBeGreaterThan(0);
    expect(screen.queryByText("Approved")).toBeNull();
  });
});
