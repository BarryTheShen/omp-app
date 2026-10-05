import type { ToolCallId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ToolCard } from "./card";
import type { ToolCardPhase, ToolCardState } from "./contract";

afterEach(() => cleanup());

function state(phase: ToolCardPhase, id = `tool-${phase}`): ToolCardState {
  return {
    toolCallId: id as ToolCallId,
    toolName: "bash",
    label: "Run bash",
    phase,
    argsText: '{"command":"echo hi"}',
    argsComplete: true,
    executionStarted: phase !== "running",
    result: phase === "success" ? "done" : undefined,
    isError: phase === "error",
    defaultOpen: phase !== "success",
  };
}

describe("ToolCard state grammar", () => {
  test.each([
    ["running", "Running", "bg-info-surface"],
    ["partial", "Streaming", "bg-info-surface"],
    ["success", "Complete", "bg-success-surface"],
    ["error", "Error", "bg-danger-surface"],
    ["cancelled", "Cancelled", "bg-muted"],
  ] as const)("renders %s with its tokenized chip", (phase, label, surface) => {
    render(<ToolCard state={state(phase)} />);
    const chip = screen.getByTestId(`tool-state-chip-${phase}`);
    expect(chip.textContent).toContain(label);
    expect(chip.className).toContain(surface);
  });

  test("has an accessible disclosure button and toggles with Enter and Space", () => {
    render(<ToolCard state={state("success", "keyboard")} />);
    const trigger = screen.getByRole("button", { name: "Run bash: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(trigger, { key: " " });
    fireEvent.keyUp(trigger, { key: " " });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("remembers a manual disclosure choice per toolCallId", () => {
    const first = render(<ToolCard state={state("running", "remembered")} />);
    const trigger = screen.getByRole("button", { name: "Run bash: Running" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    first.unmount();

    render(<ToolCard state={state("success", "remembered")} />);
    expect(
      screen.getByRole("button", { name: "Run bash: Complete" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("shows explicit truncation and expands the bounded preview", () => {
    const result = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
    render(
      <ToolCard
        state={{
          ...state("success", "truncated"),
          result,
          outputMeta: {
            truncation: {
              direction: "tail",
              reason: "lines",
              omittedLines: 8,
            },
          },
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Run bash: Complete" });
    fireEvent.click(trigger);

    expect(screen.getAllByText("Output shortened; omitted 8 lines")).toHaveLength(1);
    const showMore = screen.getByRole("button", { name: "Show more" });
    const output = screen
      .getByTestId("tool-card-truncated")
      .querySelector('[data-slot="u3-tool-card-result"] pre');
    expect(output?.textContent).toContain("line-0");
    expect(output?.textContent).not.toContain("line-19");
    fireEvent.click(showMore);
    expect(output?.textContent).toContain("line-19");
  });

  test("copies raw result through the supplied callback", () => {
    const onCopy = vi.fn();
    render(
      <ToolCard onCopy={onCopy} state={{ ...state("success", "copy"), result: "raw result" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy raw result" }));
    expect(onCopy).toHaveBeenCalledWith("raw result", "result");
  });
  test("does not echo raw JSON arguments when no renderer summary is supplied", () => {
    render(<ToolCard state={state("success", "summary")} />);
    const trigger = screen.getByRole("button", { name: "Run bash: Complete" });
    expect(trigger.textContent).not.toContain("echo hi");
    expect(trigger.textContent).not.toContain("command");
  });

  test("opens first error and cancellation cards with safe accessible messages", () => {
    render(
      <ToolCard
        state={{
          ...state("error", "error-message"),
          error: { message: "The tool failed safely", retryable: true },
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The tool failed safely");
    expect(
      screen.getByRole("button", { name: "Run bash: Error" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
