import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "./contract";
import { ToolFallback } from "./fallback";
import { TOOL_CARD_FIXTURES } from "./fixtures/lifecycle";
import * as toolCard from "./index";
import { normalizeToolCall } from "./normalize";
import { expandToolCards } from "./test-support";

afterEach(() => cleanup());

describe("tool-card lifecycle fixtures", () => {
  for (const fixture of TOOL_CARD_FIXTURES) {
    test(`normalizes ${fixture.name}`, () => {
      expect(normalizeToolCall(fixture.input)).toMatchObject(fixture.expect);
    });
  }

  for (const fixture of TOOL_CARD_FIXTURES.filter((item) => item.label !== undefined)) {
    test(`the generic card shows ${fixture.label} for ${fixture.name}`, () => {
      render(<ToolFallback {...(fixture.input as ToolRendererProps)} />);
      expect(
        screen.getByRole("button", { name: `${fixture.input.toolName}: ${fixture.label}` }),
      ).toBeTruthy();
    });
  }

  test("the bash card says a command timed out, from the result omp sends", () => {
    const timeout = TOOL_CARD_FIXTURES.find((item) => item.name.startsWith("timeout:"));
    if (timeout === undefined) throw new Error("No timeout fixture");
    render(<toolCard.BashCard rendererProps={timeout.input as ToolRendererProps} />);
    expandToolCards();
    expect(screen.getByText("Command timed out.")).toBeTruthy();
  });

  test("calls that run at once keep their own ids across normalization", () => {
    const concurrent = TOOL_CARD_FIXTURES.filter((item) =>
      item.name.startsWith("stable concurrent ids"),
    );
    const [first, second] = concurrent;
    if (first === undefined || second === undefined) throw new Error("No concurrent fixtures");
    const firstId = normalizeToolCall(first.input).toolCallId;
    expect(firstId).toBe(first.input.toolCallId);
    expect(normalizeToolCall(second.input).toolCallId).toBe(second.input.toolCallId);
    expect(normalizeToolCall(second.input).toolCallId).not.toBe(firstId);
    expect(normalizeToolCall(first.input).toolCallId).toBe(firstId);
  });
});

describe("tool-card public barrel", () => {
  test("exports every name the tool-card parts publish", () => {
    expect(typeof toolCard.normalizeToolCall).toBe("function");
    expect(typeof toolCard.normalizeToolRendererProps).toBe("function");
    expect(typeof toolCard.ToolCard).toBe("function");
    expect(typeof toolCard.copyStatusText).toBe("function");
    expect(typeof toolCard.createToolRegistry).toBe("function");
    expect(typeof toolCard.ToolFallback).toBe("function");
    expect(typeof toolCard.NestedTranscript).toBe("function");
    expect(toolCard.MAX_NESTED_TRANSCRIPT_DEPTH).toBe(32);
    expect(typeof toolCard.BashToolRenderer).toBe("function");
    expect(typeof toolCard.BashCard).toBe("function");
    expect(toolCard.U3_BASH_DESCRIPTOR).toBeDefined();
  });
});
