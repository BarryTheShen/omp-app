import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { RecallRenderer } from "../recall";

afterEach(cleanup);

describe("T6 recall renderer", () => {
  test("lists each memory without the result's own bullet marker", () => {
    render(
      <RecallRenderer
        {...({
          type: "tool-call",
          toolCallId: "recall-list",
          toolName: "recall",
          args: { query: "settings" },
          argsText: '{"query":"settings"}',
          result: {
            content: [
              {
                type: "text",
                text: "Found 1 relevant memory:\n\n- Context settings use the shared settings kit.",
              },
            ],
            details: {},
          },
          isError: false,
          status: { type: "complete", reason: "stop" },
        } as unknown as ToolRendererProps)}
      />,
    );
    expandToolCards();
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toContain("Context settings use the shared settings kit.");
    expect(items.some((text) => text?.startsWith("- "))).toBe(false);
  });
});
