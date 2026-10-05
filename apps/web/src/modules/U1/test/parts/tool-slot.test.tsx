import type { EnrichedPartState } from "@assistant-ui/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { ToolRenderer } from "@/modules/U3/tool-card/contract";
import { normalizeToolRendererProps } from "@/modules/U3/tool-card/normalize";
import { ToolSlot } from "../../tool-slots";

const part = {
  type: "tool-call",
  toolCallId: "call-parts-1",
  toolName: "bash",
  args: { command: "echo fixture-tool" },
  argsText: '{"command":"echo fixture-tool"}',
  status: { type: "running" },
} as unknown as Extract<EnrichedPartState, { type: "tool-call" }>;

describe("U1.3 tool slot boundary", () => {
  test("normalizes a malformed part into a visible error state without executing it", () => {
    const normalized = normalizeToolRendererProps({
      ...part,
      toolCallId: "",
      toolName: "",
    });
    expect(normalized.phase).toBe("error");
    expect(normalized.error?.message).toContain("Unable to render");
  });

  test("routes by tool name to a U3 renderer when provided", () => {
    const renderer = ((props) => (
      <div data-slot="u3-rendered-tool">{props.toolName}</div>
    )) as ToolRenderer;
    render(<ToolSlot part={part} renderers={{ bash: renderer }} />);
    expect(screen.getByText("bash")).toBeTruthy();
    expect(document.querySelector('[data-slot="u3-rendered-tool"]')).toBeTruthy();
  });
});
