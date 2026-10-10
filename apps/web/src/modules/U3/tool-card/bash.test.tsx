import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
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

describe("BashCard", () => {
  test("uses the command as a single-line header summary", () => {
    render(<BashCard rendererProps={props(result(), { type: "running" })} />);

    const trigger = screen.getByRole("button", { name: "bash: Running" });
    expect(trigger.textContent).toContain("printf 'hello'");
    expect(screen.getByTestId("u3-bash-card").getAttribute("title")).toBe("printf 'hello'");
  });

  test("maps ANSI color escapes to semantic token classes without raw escapes", () => {
    render(<BashCard rendererProps={props(result({ output: "\u001b[31mred\u001b[0m plain" }))} />);

    const stdout = screen.getByTestId("u3-bash-stdout");
    expect(stdout.querySelector(".text-danger")?.textContent).toBe("red");
    expect(stdout.textContent).not.toContain("\u001b");
  });

  test("maps zero and non-zero exit codes to success and error cards", () => {
    const { unmount } = render(<BashCard rendererProps={props(result({ exitCode: 0 }))} />);
    expect(screen.getByTestId("tool-card-bash-call").getAttribute("data-phase")).toBe("success");
    unmount();

    render(<BashCard rendererProps={props(result({ output: "bad", exitCode: 2 }))} />);
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

    const outputBlock = screen.getByTestId("u3-bash-stdout");
    expect(outputBlock.textContent).toContain("line-0");
    expect(outputBlock.textContent).not.toContain("line-19");
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 lines" }));
    expect(outputBlock.textContent).toContain("line-19");
  });

  test("stop delegates to the parent turn cancellation callback", () => {
    const onCancel = vi.fn();
    render(<BashCard onCancel={onCancel} rendererProps={props(result(), { type: "running" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("shows the output of omp's bash tool result, with wall time apart from it", () => {
    // The shape omp v18.6.1 sends in tool_execution_end and the toolResult message.
    const toolResult = {
      content: [{ type: "text", text: "fixture-tool\n\n\nWall time: 0.04 seconds" }],
      details: { timeoutSeconds: 300, wallTimeMs: 37.9 },
    };
    render(<BashCard rendererProps={props(toolResult)} />);

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

    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("line 1");
    expect(screen.queryByText("Waiting for bash output…")).toBeNull();
  });

  test("opens at first sight, and its header folds the command and output away", () => {
    // A distinct call id: the card remembers a person's fold per call, and other tests share "bash-call".
    const folding = { ...props(result({ output: "hello" })), toolCallId: "fold-call" };
    render(<BashCard rendererProps={folding as unknown as ToolRendererProps} />);
    const trigger = screen.getByRole("button", { name: "bash: Complete" });
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

  test("a failed command's card opens with its output in view", () => {
    render(<BashCard rendererProps={props(result({ output: "bad", exitCode: 2 }))} />);
    const trigger = screen.getByRole("button", { name: "bash: Error" });
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
    fireEvent.click(screen.getByRole("button", { name: "Show all 400 lines" }));
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("line 400");
  });

  test("a result of 12 lines or fewer has no note and no control", () => {
    render(<BashCard rendererProps={props(toolResult(numbered(12)))} />);
    expect(screen.getByTestId("u3-bash-stdout").textContent).toContain("line 12");
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  test("a line too long to show is cut by characters and says so", () => {
    const long = "x".repeat(9_000);
    render(<BashCard rendererProps={props(toolResult(long))} />);
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
    expect(screen.getByText("omp shortened this output: showing 20 of 4,000 lines.")).toBeTruthy();
  });

  test("colored output keeps its colors in the lines it shows and in the rest", () => {
    const colored = Array.from({ length: 20 }, (_, index) => `\u001b[32mok ${index + 1}\u001b[0m`);
    render(<BashCard rendererProps={props(toolResult(colored.join("\n")))} />);
    const stdout = screen.getByTestId("u3-bash-stdout");
    expect(stdout.querySelectorAll(".text-success")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 lines" }));
    expect(stdout.querySelectorAll(".text-success")).toHaveLength(20);
    expect(stdout.textContent).not.toContain("\u001b");
  });

  test("empty output says so and offers no control", () => {
    render(<BashCard rendererProps={props(toolResult(""))} />);
    expect(screen.getByText("No output")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });
});

describe("BashCard copy", () => {
  test("copies the whole output, not the lines the card shows, and says so", async () => {
    const onCopy = vi.fn(async () => {});
    render(<BashCard onCopy={onCopy} rendererProps={props(toolResult(numbered(40)))} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(numbered(40), "result"));
    expect(await screen.findByText("Copied raw output", { exact: true })).toBeTruthy();
  });

  test("copies the command and says so", async () => {
    const onCopy = vi.fn(async () => {});
    render(<BashCard onCopy={onCopy} rendererProps={props(toolResult("ok"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy bash command" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith("printf 'hello'", "code"));
    expect(await screen.findByText("Copied command", { exact: true })).toBeTruthy();
  });

  test("says the copy failed when the handler refuses", async () => {
    const onCopy = vi.fn(async () => {
      throw new Error("denied");
    });
    render(<BashCard onCopy={onCopy} rendererProps={props(toolResult("ok"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    expect(await screen.findByText("Copy unavailable", { exact: true })).toBeTruthy();
  });

  test("says only the shown part was copied when the thread cut the output", async () => {
    const onCopy = vi.fn(async () => {});
    const cut = { ...toolResult(numbered(40)), outputCut: { shownBytes: 4, totalBytes: 40 } };
    render(<BashCard onCopy={onCopy} rendererProps={props(cut)} />);
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
    fireEvent.click(screen.getByRole("button", { name: "Copy raw stderr" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith("boom", "result"));
    expect(await screen.findByText("Copied raw stderr", { exact: true })).toBeTruthy();
  });

  test("copies to the clipboard when no handler is given, and says so when there is none", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const first = render(<BashCard rendererProps={props(toolResult("ok"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy raw output" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ok"));
    expect(await screen.findByText("Copied raw output", { exact: true })).toBeTruthy();
    first.unmount();

    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<BashCard rendererProps={props(toolResult("ok"))} />);
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
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();

    rerender(<BashCard rendererProps={props(toolResult(numbered(40)))} />);
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
    expect(
      screen.getByText("Showing the 8 loaded lines; the app has loaded 64 KB of 205 KB.", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
