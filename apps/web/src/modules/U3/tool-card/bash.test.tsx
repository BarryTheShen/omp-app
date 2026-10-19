import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useMemo, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BackgroundJobView } from "@/modules/R0/store/background-jobs";
import {
  MemoryThinkingVisibilityStore,
  TranscriptDisplayPolicyProvider,
  useTranscriptDisplayPolicy,
} from "@/modules/U1/policy/policy";
import { ReadOnlyNestedTranscript, TurnCancelContext } from "@/modules/U1/thread";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import {
  BackgroundJobCommandContext,
  BackgroundJobsContext,
  type BackgroundJobsScope,
  type StopOutcome,
} from "./background-job";
import { BashCard, decodeBashResult, failureMessage } from "./bash";
import type { ToolRendererProps } from "./contract";
import { FullOutputProvider } from "./full-output";

afterEach(() => cleanup());

function props(result: unknown, status: unknown = { type: "complete" }): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "bash-call",
    toolName: "bash",
    args: { command: "printf 'hello'" },
    argsText: '{"command":"printf hello"}',
    result,
    status,
  } as unknown as ToolRendererProps;
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    output: "hello",
    cancelled: false,
    truncated: false,
    totalLines: 1,
    totalBytes: 5,
    outputLines: 1,
    outputBytes: 5,
    ...overrides,
  };
}

/** A numbered output: "line 01" through "line N". */
function numbered(count: number): string {
  const numbers = Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, "0"));
  return numbers.map((number) => `line ${number}`).join("\n");
}

/** The tool result omp sends for a bash call: the output, omp's wall-time footer, and `details`. */
function toolResult(output: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: `${output}\n\nWall time: 0.01 seconds` }],
    details: { wallTimeMs: 13, ...details },
  };
}

/** The button that toggles the transcript's expand-all flag, inside the provider the cards read. */
function PolicyControls() {
  const policy = useTranscriptDisplayPolicy();
  return (
    <button type="button" onClick={policy.toggleExpandTools}>
      Toggle tool output
    </button>
  );
}

describe("BashCard notes omp adds to a failed command", () => {
  test("the output shows only what the command printed, not omp's wall-time and exit-code notes", () => {
    const onCopy = vi.fn(async () => {});
    const failed = {
      content: [
        {
          type: "text",
          text: "ls: /nonexistent: No such file or directory\n\nWall time: 0.05 seconds\n\nCommand exited with code 2",
        },
      ],
      details: { wallTimeMs: 50, exitCode: 2 },
    };
    render(<BashCard onCopy={onCopy} rendererProps={props(failed)} />);
    expandToolCards();
    const shown = screen.getByTestId("u3-bash-stdout").querySelector("pre")?.textContent;
    expect(shown).toBe("ls: /nonexistent: No such file or directory");
    expect(screen.getByText("Exit code: 2")).toBeTruthy();
    expect(screen.getByText("Wall time: 50ms")).toBeTruthy();
    expect(screen.getByText("Command exited with code 2.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    expect(onCopy).toHaveBeenCalledWith("ls: /nonexistent: No such file or directory", "result");
  });

  test("a failed command that printed nothing shows no output, not omp's notes", () => {
    const failed = {
      content: [
        { type: "text", text: "\n\nWall time: 0.05 seconds\n\nCommand exited with code 1" },
      ],
      details: { wallTimeMs: 50, exitCode: 1 },
    };
    render(<BashCard rendererProps={props(failed)} />);
    expandToolCards();
    expect(screen.getByText("No output")).toBeTruthy();
    expect(screen.queryByTestId("u3-bash-stdout")).toBeNull();
  });
});

describe("BashCard", () => {
  test("uses the command as a single-line header summary", () => {
    render(<BashCard rendererProps={props(result(), { type: "running" })} />);

    const trigger = screen.getByRole("button", { name: "bash: Running" });
    expect(trigger.textContent).toContain("printf 'hello'");
    expect(screen.getByTestId("u3-bash-card").getAttribute("title")).toBe("printf 'hello'");
  });

  test("maps ANSI color escapes to semantic token classes without raw escapes", () => {
    render(<BashCard rendererProps={props(result({ output: "\u001b[31mred\u001b[0m plain" }))} />);
    expandToolCards();

    const stdout = screen.getByTestId("u3-bash-stdout");
    expect(stdout.querySelector(".text-danger")?.textContent).toBe("red");
    expect(stdout.textContent).not.toContain("\u001b");
  });

  test("maps zero and non-zero exit codes to success and error cards", () => {
    const { unmount } = render(<BashCard rendererProps={props(result({ exitCode: 0 }))} />);
    expect(screen.getByTestId("tool-card-bash-call").getAttribute("data-phase")).toBe("success");
    unmount();

    render(<BashCard rendererProps={props(result({ output: "bad", exitCode: 2 }))} />);
    expandToolCards();
    expect(screen.getByTestId("tool-card-bash-call").getAttribute("data-phase")).toBe("error");
    expect(screen.getByRole("alert").textContent).toContain("exited with code 2");
  });

  test("shows long output truncation and expands it", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
    render(
      <BashCard
        rendererProps={props(result({ output, truncated: true, totalLines: 20, outputLines: 20 }))}
      />,
    );
    expandToolCards();

    const outputBlock = screen.getByTestId("u3-bash-stdout");
    expect(outputBlock.textContent).toContain("line-0");
    expect(outputBlock.textContent).not.toContain("line-19");
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 lines" }));
    expect(outputBlock.textContent).toContain("line-19");
  });

  test("stop delegates to the parent turn cancellation callback", () => {
    const onCancel = vi.fn();
    render(<BashCard onCancel={onCancel} rendererProps={props(result(), { type: "running" })} />);
    expandToolCards();

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("a running bash card stops the chat's turn when it has no stop of its own", () => {
    const chatCancel = vi.fn(async () => undefined);
    render(
      <TurnCancelContext.Provider value={chatCancel}>
        <BashCard rendererProps={props(result(), { type: "running" })} />
      </TurnCancelContext.Provider>,
    );
    expandToolCards();

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    expect(chatCancel).toHaveBeenCalledOnce();
  });

  test("a running bash card with no output yet still offers Stop turn, which the app's running card has until its output arrives", () => {
    const onCancel = vi.fn();
    render(<BashCard onCancel={onCancel} rendererProps={props(undefined, { type: "running" })} />);
    expandToolCards();

    expect(screen.getByText("No output yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("a running bash card in a read-only transcript has no Stop turn, even under the chat's turn stop", () => {
    const chatCancel = vi.fn(async () => undefined);
    render(
      <TurnCancelContext.Provider value={chatCancel}>
        <ReadOnlyNestedTranscript messages={[]}>
          <BashCard rendererProps={props(undefined, { type: "running" })} />
        </ReadOnlyNestedTranscript>
      </TurnCancelContext.Provider>,
    );
    expandToolCards();
    expect(screen.getByText("No output yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();
  });

  test("shows the output of omp's bash tool result, with wall time apart from it", () => {
    // The shape omp v18.6.1 sends in tool_execution_end and the toolResult message.
    const toolResult = {
      content: [{ type: "text", text: "fixture-tool\n\n\nWall time: 0.04 seconds" }],
      details: { timeoutSeconds: 300, wallTimeMs: 37.9 },
    };
    render(<BashCard rendererProps={props(toolResult)} />);
    expandToolCards();

    const stdout = screen.getByTestId("u3-bash-stdout").textContent ?? "";
    expect(stdout).toContain("fixture-tool");
    expect(stdout).not.toContain("Wall time");
    expect(screen.getByText("Wall time: 38ms")).toBeTruthy();
    expect(screen.queryByText("Waiting for bash output…")).toBeNull();
  });

  test("streams partial output while the command runs", () => {
    // R0 puts a running call's latest partialResult in the part's `result` while status is running.
    render(
      <BashCard
        rendererProps={props(
          { content: [{ type: "text", text: "line 1\n" }], details: {} },
          { type: "running" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("line 1");
    expect(screen.queryByText("Waiting for bash output…")).toBeNull();
  });

  test("says no output has come yet while the command runs, and never that it is waiting", () => {
    const { unmount } = render(<BashCard rendererProps={props(undefined, { type: "running" })} />);
    expandToolCards();
    expect(screen.getByText("No output yet.")).toBeTruthy();
    expect(screen.queryByText(/Waiting/)).toBeNull();
    unmount();

    render(
      <BashCard
        rendererProps={{
          ...props(undefined, { type: "incomplete", reason: "cancelled" }),
          toolCallId: "stopped-call",
        }}
      />,
    );
    expandToolCards();
    // A command that was stopped before it printed anything has one state, not two.
    expect(screen.queryByText("No output yet.")).toBeNull();
    expect(screen.getByText("No output was recorded.")).toBeTruthy();
    expect(screen.getByTestId("tool-card-stopped-call").getAttribute("data-phase")).toBe(
      "cancelled",
    );
  });

  test("a finished command starts as one line and opens to the command and output on click", () => {
    // A distinct call id: the card remembers a person's fold per call, and other tests share "bash-call".
    const folding = { ...props(result({ output: "hello" })), toolCallId: "fold-call" };
    render(<BashCard rendererProps={folding as unknown as ToolRendererProps} />);
    const trigger = screen.getByRole("button", { name: "bash: Complete" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("u3-bash-stdout")).toBeNull();
    expect(screen.queryByText("$ printf 'hello'")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("hello");
    expect(screen.getByText("$ printf 'hello'")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("u3-bash-stdout")).toBeNull();
    expect(screen.queryByText("$ printf 'hello'")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("hello");
  });

  test("a failed command reads Error on its line and opens to its output on click", () => {
    // A distinct call id: the card remembers a person's open state per call, and other tests share "bash-call".
    render(
      <BashCard
        rendererProps={{
          ...props(result({ output: "bad", exitCode: 2 })),
          toolCallId: "failed-call",
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "bash: Error" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("u3-bash-stdout")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("bad");
  });
});

describe("failureMessage", () => {
  function reasonFor(output: string): string {
    const decoded = decodeBashResult(result({ output }));
    if (decoded === undefined) throw new Error("the bash result did not decode");
    return failureMessage(decoded);
  }

  test("names the reason omp wrote last, after the output it printed", () => {
    expect(reasonFor("fatal: cannot read\n[Command aborted]")).toBe("[Command aborted]");
  });

  test("names a `Command failed` reason that omp appended", () => {
    expect(reasonFor("step one\nCommand failed: missing exit status")).toBe(
      "Command failed: missing exit status",
    );
  });

  test("falls back to the first printed line when omp appended no reason", () => {
    expect(reasonFor("no such directory: /tmp/missing\nmore output")).toBe(
      "no such directory: /tmp/missing",
    );
  });

  test("says so when the command printed nothing", () => {
    expect(reasonFor("")).toBe("Command failed without printing a reason.");
  });
});

describe("BashCard output in full", () => {
  test("shows the first 12 of 40 lines, and a control that shows all 40", () => {
    render(<BashCard rendererProps={props(toolResult(numbered(40)))} />);
    expandToolCards();
    const stdout = screen.getByTestId("u3-bash-stdout");
    expect(stdout.textContent).toContain("line 12");
    expect(stdout.textContent).not.toContain("line 13");
    expect(stdout.textContent).not.toContain("…");
    expect(screen.getByText("Showing the first 12 of 40 lines.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show all 40 lines" }));
    expect(stdout.textContent).toContain("line 40");
    expect(screen.queryByText("Showing the first 12 of 40 lines.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show fewer lines" }));
    expect(stdout.textContent).not.toContain("line 13");
  });

  test("a 400-line result reaches its last line", () => {
    render(<BashCard rendererProps={props(toolResult(numbered(400)))} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Show all 400 lines" }));
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("line 400");
  });

  test("a result of 12 lines or fewer has no note and no control", () => {
    render(<BashCard rendererProps={props(toolResult(numbered(12)))} />);
    expandToolCards();
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("line 12");
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  test("a line too long to show is cut by characters and says so", () => {
    const long = "x".repeat(9_000);
    render(<BashCard rendererProps={props(toolResult(long))} />);
    expandToolCards();
    expect(screen.getByText("Showing the first 8,000 of 9,000 characters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all 9,000 characters" }));
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain(long);
  });

  test("an output omp shortened says what it left out, from the tool result's own counts", () => {
    const meta = {
      truncation: {
        direction: "tail",
        truncatedBy: "lines",
        totalLines: 4000,
        outputLines: 20,
        totalBytes: 250000,
        outputBytes: 180,
      },
    };
    render(<BashCard rendererProps={props(toolResult(numbered(20), { meta }))} />);
    expandToolCards();
    expect(screen.getByText("omp shortened this output: showing 20 of 4,000 lines.")).toBeTruthy();
    expect(screen.getByText("Showing the first 12 of 20 lines.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all 20 lines" })).toBeTruthy();
  });

  test("an RPC bash result flagged as truncated says omp shortened it", () => {
    const rpc = result({
      output: numbered(20),
      truncated: true,
      totalLines: 4000,
      outputLines: 20,
      totalBytes: 250000,
      outputBytes: 180,
    });
    render(<BashCard rendererProps={props(rpc)} />);
    expandToolCards();
    expect(screen.getByText("omp shortened this output: showing 20 of 4,000 lines.")).toBeTruthy();
  });

  test("colored output keeps its colors in the lines it shows and in the rest", () => {
    const colored = Array.from({ length: 20 }, (_, index) => `\u001b[32mok ${index + 1}\u001b[0m`);
    render(<BashCard rendererProps={props(toolResult(colored.join("\n")))} />);
    expandToolCards();
    const stdout = screen.getByTestId("u3-bash-stdout");
    expect(stdout.querySelectorAll(".text-success")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 lines" }));
    expect(stdout.querySelectorAll(".text-success")).toHaveLength(20);
    expect(stdout.textContent).not.toContain("\u001b");
  });

  test("empty output says so and offers no control", () => {
    render(<BashCard rendererProps={props(toolResult(""))} />);
    expandToolCards();
    expect(screen.getByText("No output")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });
});

describe("BashCard copy", () => {
  test("copies the whole output, not the lines the card shows, and says so", async () => {
    const onCopy = vi.fn(async () => {});
    render(<BashCard onCopy={onCopy} rendererProps={props(toolResult(numbered(40)))} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(numbered(40), "result"));
    expect(await screen.findByText("Copied raw output", { exact: true })).toBeTruthy();
  });

  test("copies the command and says so", async () => {
    const onCopy = vi.fn(async () => {});
    render(<BashCard onCopy={onCopy} rendererProps={props(toolResult("ok"))} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy bash command" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith("printf 'hello'", "code"));
    expect(await screen.findByText("Copied command", { exact: true })).toBeTruthy();
  });

  test("says the copy failed when the handler refuses", async () => {
    const onCopy = vi.fn(async () => {
      throw new Error("denied");
    });
    render(<BashCard onCopy={onCopy} rendererProps={props(toolResult("ok"))} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    expect(await screen.findByText("Copy unavailable", { exact: true })).toBeTruthy();
  });

  test("says only the shown part was copied when the thread cut the output", async () => {
    const onCopy = vi.fn(async () => {});
    const cut = { ...toolResult(numbered(40)), outputCut: { shownBytes: 4, totalBytes: 40 } };
    render(<BashCard onCopy={onCopy} rendererProps={props(cut)} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    expect(
      await screen.findByText(
        "Copied the shown part of the output. Load the full output to copy all of it.",
        { exact: true },
      ),
    ).toBeTruthy();
  });

  test("says the shown part was copied when omp shortened the output", async () => {
    const meta = {
      truncation: {
        direction: "tail",
        truncatedBy: "lines",
        totalLines: 4000,
        outputLines: 20,
        totalBytes: 250000,
        outputBytes: 180,
      },
    };
    const onCopy = vi.fn(async () => {});
    render(<BashCard onCopy={onCopy} rendererProps={props(toolResult(numbered(20), { meta }))} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    expect(
      await screen.findByText("Copied the shown part of the output.", { exact: true }),
    ).toBeTruthy();
  });

  test("copies stderr with its own control", async () => {
    const onCopy = vi.fn(async () => {});
    render(
      <BashCard
        onCopy={onCopy}
        rendererProps={props(result({ output: "ok", stderr: "boom\n" }))}
      />,
    );
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw stderr" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith("boom", "result"));
    expect(await screen.findByText("Copied raw stderr", { exact: true })).toBeTruthy();
  });

  test("copies to the clipboard when no handler is given, and says so when there is none", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const first = render(<BashCard rendererProps={props(toolResult("ok"))} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ok"));
    expect(await screen.findByText("Copied raw output", { exact: true })).toBeTruthy();
    first.unmount();

    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<BashCard rendererProps={props(toolResult("ok"))} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    expect(await screen.findByText("Copy unavailable", { exact: true })).toBeTruthy();
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

describe("BashCard copy confirmation", () => {
  test("clears a copy confirmation after 1.5 seconds, and its timer goes with the card", async () => {
    vi.useFakeTimers();
    try {
      const onCopy = vi.fn(async () => {});
      const card = render(<BashCard onCopy={onCopy} rendererProps={props(toolResult("ok"))} />);
      expandToolCards();
      fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
      await act(async () => {});
      expect(screen.getByText("Copied raw output", { exact: true })).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1_499);
      });
      expect(screen.getByText("Copied raw output", { exact: true })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByText("Copied raw output", { exact: true })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
      await act(async () => {});
      const pending = vi.getTimerCount();
      card.unmount();
      expect(vi.getTimerCount()).toBeLessThan(pending);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BashCard output the app holds in part", () => {
  test("says once what the app holds, with Load full output, and offers no Show all", () => {
    const loadFull = vi.fn(async () => {});
    const partial = {
      ...toolResult(numbered(40)),
      outputCut: { shownBytes: 65_536, totalBytes: 209_715 },
    };
    render(
      <FullOutputProvider value={loadFull}>
        <BashCard rendererProps={props(partial)} />
      </FullOutputProvider>,
    );
    expandToolCards();
    const note = screen.getByText(
      "Showing the first 12 lines of the 40 loaded; the app has loaded 64 KB of 205 KB.",
      { exact: true },
    );
    const load = screen.getByRole("button", { name: "Load full output" });
    expect(note.compareDocumentPosition(load) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(screen.queryByText(/Showing the first 12 of 40 lines/)).toBeNull();
    expect(screen.queryByText(/Showing the start and end of/)).toBeNull();

    fireEvent.click(load);
    expect(loadFull).toHaveBeenCalledWith("bash-call");
  });

  test("once the full output is loaded, the card offers its own preview note and Show all", () => {
    const partial = {
      ...toolResult(numbered(40)),
      outputCut: { shownBytes: 65_536, totalBytes: 209_715 },
    };
    const { rerender } = render(<BashCard rendererProps={props(partial)} />);
    expandToolCards();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();

    rerender(<BashCard rendererProps={props(toolResult(numbered(40)))} />);
    expandToolCards();
    expect(screen.getByText("Showing the first 12 of 40 lines.", { exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all 40 lines" })).toBeTruthy();
    expect(screen.queryByText(/loaded; the app has loaded/)).toBeNull();
  });

  test("a loaded output of 12 lines or fewer says what it holds, and has no preview control", () => {
    const partial = {
      ...toolResult(numbered(8)),
      outputCut: { shownBytes: 65_536, totalBytes: 209_715 },
    };
    render(<BashCard rendererProps={props(partial)} />);
    expandToolCards();
    expect(
      screen.getByText("Showing the 8 loaded lines; the app has loaded 64 KB of 205 KB.", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  test("after Load full output, focus moves to Show all N lines, and the card says the full output loaded", async () => {
    const held = Promise.withResolvers<void>();
    const loadFull = vi.fn(() => held.promise);
    const partial = {
      ...toolResult(numbered(40)),
      outputCut: { shownBytes: 65_536, totalBytes: 209_715 },
    };
    const { rerender } = render(
      <FullOutputProvider value={loadFull}>
        <BashCard rendererProps={props(partial)} />
      </FullOutputProvider>,
    );
    expandToolCards();
    const load = screen.getByRole("button", { name: "Load full output" });
    load.focus();
    fireEvent.click(load);
    // While the output loads, the button keeps focus.
    expect(document.activeElement).toBe(load);

    // The thread replaces the partial result with the full one, and the load finishes.
    rerender(
      <FullOutputProvider value={loadFull}>
        <BashCard rendererProps={props(toolResult(numbered(40)))} />
      </FullOutputProvider>,
    );
    expandToolCards();
    await act(async () => held.resolve());

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show all 40 lines" }));
    expect(screen.getByText("Full output loaded")).toBeTruthy();
  });

  test("with every tool call expanded, the note says every loaded line is shown, not the first 12", () => {
    const partial = {
      ...toolResult(numbered(40)),
      outputCut: { shownBytes: 65_536, totalBytes: 209_715 },
    };
    render(
      <TranscriptDisplayPolicyProvider
        storage={new MemoryThinkingVisibilityStore()}
        threadId="bash-expand-all-cut"
      >
        <PolicyControls />
        <BashCard rendererProps={props(partial)} />
      </TranscriptDisplayPolicyProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle tool output" }));
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("line 40");
    expect(
      screen.getByText("Showing the 40 loaded lines; the app has loaded 64 KB of 205 KB.", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Showing the first 12/)).toBeNull();
  });
});

describe("a command the person stopped", () => {
  test("reads Cancelled, with no error banner and no output that only repeats omp's abort line", () => {
    render(
      <BashCard
        rendererProps={props(
          { content: [{ type: "text", text: "Command aborted" }], details: {} },
          { type: "incomplete", reason: "cancelled" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "bash: Cancelled" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Command aborted")).toBeNull();
  });
});

describe("a command omp moved to the background", () => {
  // The tool result omp sent the app when a steer backgrounded a running `sleep 20` (real omp 18.8.9, recorded from
  // the app's live run): the text is omp's notice for the model; `details.async` is omp's record of the job.
  const backgrounded = {
    content: [
      {
        type: "text",
        text: "Backgrounded early to handle an incoming message; the command keeps running.\n\nBackgrounded as job bg_1 (killed once it has run 300s in total; `timeout: 0` disables the deadline); its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it (no `sleep`, `ps`, `pgrep`, `top`, `pidwait`, log tailing): every poll is a wasted turn. Do other work, or end your reply and wait to be woken.",
      },
    ],
    details: { async: { state: "running", jobId: "bg_1", type: "bash" }, timeoutSeconds: 300 },
    isError: false,
  };
  const running: BackgroundJobView = { kind: "running", jobId: "bg_1" };

  /**
   * The chat's jobs for a test: the view it gives this job, and the stops its cards keep in state, as ToolRunScope keeps
   * them. A stop recorded here re-renders the cards, as it does in the chat.
   */
  function ChatJobs({
    view,
    stops = [],
    children,
  }: {
    readonly view: BackgroundJobView | undefined;
    readonly stops?: readonly (readonly [string, StopOutcome])[];
    readonly children: ReactNode;
  }) {
    const [outcomes, setOutcomes] = useState(() => new Map<string, StopOutcome>(stops));
    const scope = useMemo<BackgroundJobsScope>(
      () => ({
        viewOf: () => view,
        outcomeOf: (toolCallId) => outcomes.get(toolCallId),
        recordOutcome: (toolCallId, outcome) =>
          setOutcomes((current) => new Map(current).set(toolCallId, outcome)),
      }),
      [view, outcomes],
    );
    return (
      <BackgroundJobsContext.Provider value={scope}>{children}</BackgroundJobsContext.Provider>
    );
  }

  test("says it runs in the background without exposing its job number", () => {
    render(
      <ChatJobs view={running}>
        <BashCard rendererProps={props(backgrounded)} />
      </ChatJobs>,
    );
    expandToolCards();
    expect(screen.getByText("Running in the background.", { exact: true })).toBeTruthy();
    expect(screen.getByText("In background")).toBeTruthy();
    expect(screen.queryByText(/Do NOT poll/)).toBeNull();
    expect(screen.queryByText(/Backgrounded early/)).toBeNull();
  });

  test("stops that job from the card, and shows omp's outcome in plain English", async () => {
    const run = vi.fn(async (_command: string) => ["Cancelled background job bg_1."]);
    render(
      <BackgroundJobCommandContext.Provider value={run}>
        <ChatJobs view={running}>
          <BashCard rendererProps={props(backgrounded)} />
        </ChatJobs>
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
    await waitFor(() =>
      expect(
        screen.getByText("The background command stopped before its result came back.", {
          exact: true,
        }),
      ).toBeTruthy(),
    );
    expect(run).toHaveBeenCalledWith("/jobs kill bg_1");
    expect(screen.queryByRole("button", { name: "Stop background job bg_1" })).toBeNull();
    expect(screen.getByText("Background job bg_1.", { exact: true })).toBeTruthy();
    expect(screen.getByText("Stopped", { exact: true })).toBeTruthy();
  });

  test("offers no Stop without the chat's command gateway", () => {
    render(
      <ChatJobs view={running}>
        <BashCard rendererProps={props(backgrounded)} />
      </ChatJobs>,
    );
    expandToolCards();
    expect(screen.queryByRole("button", { name: "Stop background job bg_1" })).toBeNull();
  });

  test("says a job omp no longer lists as running has already finished", async () => {
    const run = vi.fn(async (_command: string) => ['No running background job with id "bg_1".']);
    render(
      <BackgroundJobCommandContext.Provider value={run}>
        <ChatJobs view={running}>
          <BashCard rendererProps={props(backgrounded)} />
        </ChatJobs>
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
    await waitFor(() =>
      expect(
        screen.getByText("Already finished: omp has no running job with id bg_1.", { exact: true }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Stop background job bg_1" })).toBeNull();
    expect(screen.getByText("Finished", { exact: true })).toBeTruthy();
  });

  test("keeps the Stop control and shows the reason when the command does not reach omp", async () => {
    const run = vi.fn(async (_command: string): Promise<string[]> => {
      throw new Error("gateway offline");
    });
    render(
      <BackgroundJobCommandContext.Provider value={run}>
        <ChatJobs view={running}>
          <BashCard rendererProps={props(backgrounded)} />
        </ChatJobs>
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Stop background job bg_1" }));
    await waitFor(() =>
      expect(
        screen.getByText("Could not stop background job bg_1: gateway offline", { exact: true }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Stop background job bg_1" })).toBeTruthy();
  });

  test("says a finished job finished, with no Stop", () => {
    const run = vi.fn(async (_command: string) => ["Cancelled background job bg_1."]);
    render(
      <BackgroundJobCommandContext.Provider value={run}>
        <ChatJobs view={{ kind: "finished", jobId: "bg_1" }}>
          <BashCard rendererProps={props(backgrounded)} />
        </ChatJobs>
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    expect(screen.getByText("Background job bg_1 finished.", { exact: true })).toBeTruthy();
    expect(screen.getByText("Finished", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop background job/ })).toBeNull();
    expect(screen.queryByText(/Running in the background/)).toBeNull();
  });
  test("says a delivered failed job failed, with no Stop", () => {
    render(
      <BackgroundJobCommandContext.Provider value={vi.fn(async (_command: string) => [])}>
        <ChatJobs view={{ kind: "failed", jobId: "bg_1" }}>
          <BashCard rendererProps={props(backgrounded)} />
        </ChatJobs>
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    expect(screen.getByText("Background job bg_1 failed.", { exact: true })).toBeTruthy();
    expect(screen.getByText("Failed", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop background job/ })).toBeNull();
  });
  test("says a delivered cancelled job was cancelled, with no Stop", () => {
    render(
      <BackgroundJobCommandContext.Provider value={vi.fn(async (_command: string) => [])}>
        <ChatJobs view={{ kind: "cancelled", jobId: "bg_1" }}>
          <BashCard rendererProps={props(backgrounded)} />
        </ChatJobs>
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    expect(screen.getByText("Background job bg_1 cancelled.", { exact: true })).toBeTruthy();
    expect(screen.getByText("Cancelled", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop background job/ })).toBeNull();
  });

  test("says omp stopped before a job's result came back, once its process has ended", () => {
    const run = vi.fn(async (_command: string) => ["Cancelled background job bg_1."]);
    render(
      <BackgroundJobCommandContext.Provider value={run}>
        <ChatJobs view={{ kind: "ended", jobId: "bg_1" }}>
          <BashCard rendererProps={props(backgrounded)} />
        </ChatJobs>
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    expect(
      screen.getByText("The background command stopped before its result came back.", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(screen.getByText("Ended", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop background job/ })).toBeNull();
    expect(screen.queryByText(/Running in the background/)).toBeNull();
  });

  test("claims nothing about a job the chat cannot place, not even that it runs", () => {
    const run = vi.fn(async (_command: string) => ["Cancelled background job bg_1."]);
    render(
      <BackgroundJobCommandContext.Provider value={run}>
        <BashCard rendererProps={props(backgrounded)} />
      </BackgroundJobCommandContext.Provider>,
    );
    expandToolCards();
    expect(screen.getByText("Background job bg_1.", { exact: true })).toBeTruthy();
    expect(screen.getByText("In background", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop background job/ })).toBeNull();
    expect(screen.queryByText(/Running in the background/)).toBeNull();
  });

  test("keeps a stop for the chat, so a card shown again still says what its stop said", () => {
    render(
      <ChatJobs
        view={running}
        stops={[
          [
            "bash-call",
            {
              status: "stopped",
              sentence: "The background command stopped before its result came back.",
            },
          ],
        ]}
      >
        <BashCard rendererProps={props(backgrounded)} />
      </ChatJobs>,
    );
    expandToolCards();
    expect(screen.getByText("Stopped", { exact: true })).toBeTruthy();
    expect(
      screen.getByText("The background command stopped before its result came back.", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Stop background job/ })).toBeNull();
  });
});
