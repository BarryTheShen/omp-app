import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BashCard } from "./bash";
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
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(outputBlock.textContent).toContain("line-19");
  });

  test("stop delegates to the parent turn cancellation callback", () => {
    const onCancel = vi.fn();
    render(<BashCard onCancel={onCancel} rendererProps={props(result(), { type: "running" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
