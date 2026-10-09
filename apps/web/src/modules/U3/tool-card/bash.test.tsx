import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BashCard, decodeBashResult, failureMessage } from "./bash";
import type { ToolRendererProps } from "./contract";

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
