import type { ToolCallId } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MemoryThinkingVisibilityStore,
  TranscriptDisplayPolicyProvider,
  useTranscriptDisplayPolicy,
} from "@/modules/U1/policy/policy";
import { ToolCard } from "./card";
import type { ToolCardPhase, ToolCardState } from "./contract";
import { FullOutputProvider } from "./full-output";
import { TextOutput } from "./text-output";

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
  };
}

describe("ToolCard state grammar", () => {
  test.each([
    ["running", "Running", "bg-info-surface"],
    ["partial", "Streaming", "bg-info-surface"],
    ["success", "Complete", "bg-success-surface"],
    ["error", "Error", "bg-danger-surface"],
    ["cancelled", "Cancelled", "bg-muted"],
    ["unrecorded", "Finished", "bg-muted"],
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
    const first = render(<ToolCard state={state("success", "remembered")} />);
    const trigger = screen.getByRole("button", { name: "Run bash: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    first.unmount();

    render(<ToolCard state={state("success", "remembered")} />);
    expect(
      screen.getByRole("button", { name: "Run bash: Complete" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("a call still running starts as one line, and finishing it neither opens nor folds the card", () => {
    const live = render(<ToolCard state={state("running", "live-then-done")} />);
    const trigger = screen.getByRole("button", { name: "Run bash: Running" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    live.unmount();

    render(<ToolCard state={state("success", "live-then-done")} />);
    expect(
      screen.getByRole("button", { name: "Run bash: Complete" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("a card the reader opened while it ran stays open when the call finishes", () => {
    const { rerender } = render(<ToolCard state={state("running", "opened-while-running")} />);
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Running" }));
    rerender(<ToolCard state={state("success", "opened-while-running")} />);
    expect(
      screen.getByRole("button", { name: "Run bash: Complete" }).getAttribute("aria-expanded"),
    ).toBe("true");
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

  test("says only the shown part was copied when the output is cut", async () => {
    const onCopy = vi.fn(async () => {});
    render(
      <ToolCard
        onCopy={onCopy}
        state={{
          ...state("success", "cut"),
          result: { outputCut: { shownBytes: 4, totalBytes: 40 } },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy raw result" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Copied the shown part of the output. Load the full output to copy all of it.",
          { exact: true },
        ),
      ).toBeTruthy(),
    );
  });

  test("says raw output was copied when the output was not cut", async () => {
    const onCopy = vi.fn(async () => {});
    render(
      <ToolCard onCopy={onCopy} state={{ ...state("success", "whole"), result: "raw result" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy raw result" }));
    await waitFor(() =>
      expect(screen.getByText("Copied raw output", { exact: true })).toBeTruthy(),
    );
  });

  test("says the copy is unavailable, never copied, on a page with no clipboard", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      render(<ToolCard state={{ ...state("success", "no-clipboard"), result: "raw result" }} />);
      fireEvent.click(screen.getByRole("button", { name: "Run bash: Complete" }));
      fireEvent.click(screen.getByRole("button", { name: "Copy raw result" }));
      await waitFor(() =>
        expect(screen.getByText("Copy unavailable", { exact: true })).toBeTruthy(),
      );
      expect(screen.queryByText("Copied raw output", { exact: true })).toBeNull();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
      else Object.defineProperty(navigator, "clipboard", descriptor);
    }
  });

  test("copies the whole result, not the first lines the card shows", () => {
    const onCopy = vi.fn();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    render(
      <ToolCard onCopy={onCopy} state={{ ...state("success", "long-copy"), result: lines }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Complete" }));
    const shown = document.querySelector('[data-slot="u3-tool-card-result"] pre');
    expect(shown?.textContent).not.toContain("line 30");
    fireEvent.click(screen.getByRole("button", { name: "Copy raw result" }));
    expect(onCopy).toHaveBeenCalledWith(lines, "result");
  });

  test("copies the whole output so far while a call streams, not its first lines", () => {
    const onCopy = vi.fn();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    render(
      <ToolCard
        onCopy={onCopy}
        state={{ ...state("partial", "streaming-copy"), partialResult: lines }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Streaming" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy raw result" }));
    expect(onCopy).toHaveBeenCalledWith(lines, "result");
  });
  test("does not echo raw JSON arguments when no renderer summary is supplied", () => {
    render(<ToolCard state={state("success", "summary")} />);
    const trigger = screen.getByRole("button", { name: "Run bash: Complete" });
    expect(trigger.textContent).not.toContain("echo hi");
    expect(trigger.textContent).not.toContain("command");
  });

  test("a failed card reads Error on its line and opens to its safe accessible message", () => {
    render(
      <ToolCard
        state={{
          ...state("error", "error-message"),
          error: { message: "The tool failed safely", retryable: true },
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Run bash: Error" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("alert").textContent).toContain("The tool failed safely");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ToolCard with no result recorded", () => {
  test("says so in plain words where a finished call has no result, and never says Streaming", () => {
    render(<ToolCard state={state("unrecorded")} />);
    expect(screen.getAllByText("No result recorded").length).toBeGreaterThan(0);
    expect(screen.queryByText("Streaming")).toBeNull();
  });
});

describe("ToolCard queued call", () => {
  test("a queued call reads Waiting in its chip and summary, and never Streaming, Finished or No result recorded", () => {
    render(<ToolCard state={{ ...state("partial", "queued-card"), queued: true }} />);
    expect(screen.getByTestId("tool-state-chip-partial").textContent).toContain("Waiting");
    expect(screen.getByText("Waiting to start")).toBeTruthy();
    expect(screen.queryByText("Streaming")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.queryByText("No result recorded")).toBeNull();
    expect(screen.getByTestId("tool-card-queued-card").getAttribute("data-queued")).toBe("true");
  });
});

describe("ToolCard outcome", () => {
  test("an outcome names what the call's work came to, in its phase's colours, in place of the phase's words", () => {
    const { container } = render(
      <ToolCard
        state={state("success", "outcome")}
        outcome={{ label: "Failed", phase: "error" }}
        summary="Failed · 1 agent"
      />,
    );
    const chip = container.querySelector("[data-slot='u3-tool-card-status']");
    expect(chip?.textContent).toBe("Failed");
    expect(chip?.className).toContain("bg-danger-surface");
    expect(screen.queryByText("Complete")).toBeNull();
  });
});

describe("ToolCard body", () => {
  test("keeps its children inside the disclosure: they show only while it is open", () => {
    render(
      <ToolCard state={state("success", "body")}>
        <p>Body text</p>
      </ToolCard>,
    );
    const trigger = screen.getByRole("button", { name: "Run bash: Complete" });
    expect(screen.queryByText("Body text")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("Body text")).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByText("Body text")).toBeNull();
  });

  test("a card nested in another card's body starts as one line, and Expand all opens it too", () => {
    render(
      <TranscriptDisplayPolicyProvider
        storage={new MemoryThinkingVisibilityStore()}
        threadId="nested-card"
      >
        <PolicyControls />
        <ToolCard state={state("success", "outer-card")}>
          <ToolCard state={{ ...state("success", "grep-card"), label: "Run grep" }} />
          <ToolCard state={{ ...state("success", "find-card"), label: "Run find" }} />
        </ToolCard>
      </TranscriptDisplayPolicyProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Complete" }));
    const grep = screen.getByRole("button", { name: "Run grep: Complete" });
    const find = screen.getByRole("button", { name: "Run find: Complete" });
    expect(grep.getAttribute("aria-expanded")).toBe("false");
    expect(find.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(grep);
    expect(grep.getAttribute("aria-expanded")).toBe("true");
    expect(find.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Toggle tool output" }));
    expect(find.getAttribute("aria-expanded")).toBe("true");
    expect(grep.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ToolCard output the app holds in part", () => {
  test("after Load full output, focus moves to the card's Show all lines, and the card says the full output loaded", async () => {
    const held = Promise.withResolvers<void>();
    const loadFull = vi.fn(() => held.promise);
    const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const cutState = {
      ...state("success"),
      result: { output: text, outputCut: { shownBytes: 65_536, totalBytes: 209_715 } },
    };
    const fullState = { ...cutState, result: { output: text } };
    const { rerender } = render(
      <FullOutputProvider value={loadFull}>
        <ToolCard state={cutState}>
          <TextOutput text={text} />
        </ToolCard>
      </FullOutputProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run bash: Complete" }));
    const load = screen.getByRole("button", { name: "Load full output" });
    load.focus();
    fireEvent.click(load);
    expect(document.activeElement).toBe(load);

    rerender(
      <FullOutputProvider value={loadFull}>
        <ToolCard state={fullState}>
          <TextOutput text={text} />
        </ToolCard>
      </FullOutputProvider>,
    );
    await act(async () => held.resolve());

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show all 40 lines" }));
    expect(screen.getByText("Full output loaded")).toBeTruthy();
  });
});

/** Buttons that call the transcript policy's two tool toggles, inside the provider the cards read. */
function PolicyControls() {
  const policy = useTranscriptDisplayPolicy();
  return (
    <>
      <button type="button" onClick={policy.toggleTools}>
        Toggle tool activity
      </button>
      <button type="button" onClick={policy.toggleExpandTools}>
        Toggle tool output
      </button>
    </>
  );
}

describe("ToolCard under the transcript policy", () => {
  test("Expand all opens every card and its output, Collapse all closes them, and the policy hides the card", () => {
    const result = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
    const card = {
      ...state("success", "policy"),
      result,
      outputMeta: {
        truncation: { direction: "tail" as const, reason: "lines" as const, omittedLines: 8 },
      },
    };
    render(
      <TranscriptDisplayPolicyProvider
        storage={new MemoryThinkingVisibilityStore()}
        threadId="card-policy"
      >
        <PolicyControls />
        <ToolCard state={card} />
      </TranscriptDisplayPolicyProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Run bash: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle tool output" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle tool output" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Toggle tool activity" }));
    expect(screen.queryByTestId("tool-card-policy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle tool activity" }));
    expect(screen.getByTestId("tool-card-policy")).toBeTruthy();
  });

  test("Expand all forgets every card's own choice, including one that is not on screen", () => {
    function Harness() {
      const [showSecond, setShowSecond] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShowSecond((shown) => !shown)}>
            Toggle second card
          </button>
          <PolicyControls />
          <ToolCard state={state("success", "first-card")} />
          {showSecond && (
            <ToolCard state={{ ...state("success", "second-card"), label: "Run grep" }} />
          )}
        </>
      );
    }
    render(
      <TranscriptDisplayPolicyProvider
        storage={new MemoryThinkingVisibilityStore()}
        threadId="clear-all"
      >
        <Harness />
      </TranscriptDisplayPolicyProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run grep: Complete" }));
    expect(
      screen.getByRole("button", { name: "Run grep: Complete" }).getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Toggle second card" }));
    expect(screen.queryByRole("button", { name: "Run grep: Complete" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle tool output" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle tool output" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle second card" }));
    expect(
      screen.getByRole("button", { name: "Run grep: Complete" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
