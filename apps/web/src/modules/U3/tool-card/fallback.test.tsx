import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "./contract";
import { ToolFallback } from "./fallback";

afterEach(() => cleanup());

function props(overrides: Partial<ToolRendererProps> = {}): ToolRendererProps {
  return {
    toolCallId: "unknown-call",
    toolName: "custom_tool",
    args: {
      path: "workspace/file.ts",
      long: "x".repeat(400),
    },
    argsText: '{"path":"workspace/file.ts"}',
    result: { ok: true, text: "tool result" },
    status: { type: "complete" },
    ...overrides,
  } as ToolRendererProps;
}

describe("ToolFallback", () => {
  test("renders unknown tool arguments only after disclosure and keeps JSON out of the header", () => {
    render(<ToolFallback {...props()} />);
    const trigger = screen.getByRole("button", { name: "custom_tool: Complete" });

    expect(trigger.textContent).not.toContain("workspace/file.ts");
    fireEvent.click(trigger);
    expect(screen.getByText(/workspace\/file\.ts/)).toBeTruthy();
    expect(screen.getByText(/400 chars/)).toBeTruthy();
    expect(screen.getByText(/tool result/)).toBeTruthy();
  });

  test("renders a visible safe error state for an incomplete tool part", () => {
    render(
      <ToolFallback
        {...props({
          status: { type: "incomplete", reason: "error", error: "provider detail" },
          result: undefined,
        })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("tool reported an error");
    expect(
      screen.getByRole("button", { name: "custom_tool: Error" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("preserves partial output while a tool is running", () => {
    render(
      <ToolFallback
        {...props({
          status: { type: "running" },
          result: "partial output",
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "custom_tool: Running" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("partial output")).toBeTruthy();
  });
});
