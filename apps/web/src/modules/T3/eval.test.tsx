import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { EvalCard } from "./eval";
import { T3_SCRIPTED_EVAL_IMAGE_RESULT } from "./fixtures/scripted";

afterEach(() => cleanup());

function props(overrides: Partial<ToolRendererProps> = {}): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "eval-call",
    toolName: "eval",
    args: { language: "py", code: "print('hello')", title: "Greeting" },
    argsText: '{"language":"py","code":"print(hello)"}',
    status: { type: "complete" },
    ...overrides,
  } as unknown as ToolRendererProps;
}

describe("EvalCard", () => {
  test("renders language-tagged ordered cells, output, timings and async state", () => {
    render(
      <EvalCard
        rendererProps={props({
          result: {
            content: [{ type: "text", text: "streamed hello" }],
            details: {
              language: "py",
              cells: [
                {
                  index: 0,
                  title: "Greeting",
                  code: "print('hello')",
                  language: "py",
                  output: "hello",
                  status: "complete",
                  durationMs: 12,
                  exitCode: 0,
                },
                {
                  index: 1,
                  code: "print('world')",
                  language: "py",
                  output: "world",
                  status: "running",
                },
              ],
              async: { state: "running", jobId: "job-eval", type: "eval" },
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("t3-eval-header").textContent).toContain("py");
    expect(screen.getByTestId("t3-eval-cell-0").textContent).toContain("hello");
    expect(screen.getByTestId("t3-eval-cell-1").getAttribute("data-cell-status")).toBe("running");
    expect(screen.getByTestId("t3-eval-async-job").textContent).toContain("job-eval");
    expect(screen.getByTestId("tool-card-eval-call").getAttribute("data-phase")).toBe("partial");
    expect(screen.getByTestId("t3-eval-raw-details").querySelector("summary")?.textContent).toBe(
      "Raw details",
    );
  });

  test("retains partial streamed output and maps failed cells to an error card whose body shows once it opens", () => {
    render(
      <EvalCard
        rendererProps={props({
          status: { type: "running" },
          result: {
            content: [{ type: "text", text: "partial output" }],
            details: {
              language: "js",
              cells: [{ index: 0, code: "throw new Error()", status: "error", output: "partial" }],
              isError: true,
              error: { message: "Error: boom", traceback: "Traceback\\nError: boom" },
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("tool-card-eval-call").getAttribute("data-phase")).toBe("error");
    expect(screen.getByRole("alert").textContent).toContain("Error: boom");
    expect(screen.getByTestId("t3-eval-traceback").querySelector("summary")?.textContent).toBe(
      "Traceback",
    );
  });
  test("renders omp's raw base64 image content with its declared media type", () => {
    render(
      <EvalCard
        rendererProps={props({
          args: T3_SCRIPTED_EVAL_IMAGE_RESULT.args,
          result: T3_SCRIPTED_EVAL_IMAGE_RESULT.result,
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("img", { name: "Evaluation result" }).getAttribute("src")).toBe(
      `data:image/png;base64,${T3_SCRIPTED_EVAL_IMAGE_RESULT.result.content[1].data}`,
    );
  });

  test("renders only result-provided data images and leaves path-only images unavailable", () => {
    render(
      <EvalCard
        rendererProps={props({
          result: {
            details: {
              images: [
                {
                  image:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                },
                { path: "workspace/private.png" },
              ],
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("img", { name: "Evaluation result" })).toBeTruthy();
    expect(screen.getByText("Image preview is unavailable.")).toBeTruthy();
  });

  test("uses the media type an image content part declares", () => {
    const [text, image] = T3_SCRIPTED_EVAL_IMAGE_RESULT.result.content;
    render(
      <EvalCard
        rendererProps={props({
          args: T3_SCRIPTED_EVAL_IMAGE_RESULT.args,
          result: {
            ...T3_SCRIPTED_EVAL_IMAGE_RESULT.result,
            content: [text, { ...image, mimeType: "image/jpeg" }],
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("img", { name: "Evaluation result" }).getAttribute("src")).toBe(
      `data:image/jpeg;base64,${image.data}`,
    );
  });

  test("leaves an image unavailable when its bytes are not base64 or its type is not a browser image type", () => {
    const [text, image] = T3_SCRIPTED_EVAL_IMAGE_RESULT.result.content;
    render(
      <EvalCard
        rendererProps={props({
          args: T3_SCRIPTED_EVAL_IMAGE_RESULT.args,
          result: {
            ...T3_SCRIPTED_EVAL_IMAGE_RESULT.result,
            content: [
              text,
              { ...image, data: "not base64 !" },
              { ...image, mimeType: "image/svg+xml" },
            ],
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.queryByRole("img", { name: "Evaluation result" })).toBeNull();
    expect(screen.getAllByText("Image preview is unavailable.")).toHaveLength(2);
  });

  test("draws one image when the same image arrives in the details and in the content", () => {
    const [text, image] = T3_SCRIPTED_EVAL_IMAGE_RESULT.result.content;
    render(
      <EvalCard
        rendererProps={props({
          args: T3_SCRIPTED_EVAL_IMAGE_RESULT.args,
          result: {
            ...T3_SCRIPTED_EVAL_IMAGE_RESULT.result,
            content: [text, image],
            details: {
              ...T3_SCRIPTED_EVAL_IMAGE_RESULT.result.details,
              images: [{ image: `data:image/png;base64,${image.data}` }],
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getAllByRole("img", { name: "Evaluation result" })).toHaveLength(1);
  });

  test("does not read a text content part as an image", () => {
    const [text] = T3_SCRIPTED_EVAL_IMAGE_RESULT.result.content;
    render(
      <EvalCard
        rendererProps={props({
          args: T3_SCRIPTED_EVAL_IMAGE_RESULT.args,
          result: { ...T3_SCRIPTED_EVAL_IMAGE_RESULT.result, content: [text] },
        })}
      />,
    );
    expandToolCards();

    expect(screen.queryByRole("img", { name: "Evaluation result" })).toBeNull();
    expect(screen.queryByText("Image preview is unavailable.")).toBeNull();
  });
  test("reports how many cells fit in the bounded preview", () => {
    render(
      <EvalCard
        rendererProps={props({
          result: {
            details: {
              cells: Array.from({ length: 129 }, (_, index) => ({
                index,
                code: `print(${index})`,
                output: String(index),
                status: "complete",
              })),
            },
          },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByText("Showing 128 of 129 cells.")).toBeTruthy();
  });

  test("makes malformed details visible and preserves the raw result preview", () => {
    render(
      <EvalCard
        rendererProps={props({
          result: { content: [{ type: "text", text: "raw partial" }], details: "malformed" },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("tool-card-eval-call").getAttribute("data-phase")).toBe("error");
    expect(screen.getByRole("alert").textContent).toContain("malformed");
    fireEvent.click(
      screen.getByTestId("t3-eval-raw-details").querySelector("summary") as HTMLElement,
    );
    expect(screen.getByTestId("t3-eval-raw-details").textContent).toContain("raw partial");
  });

  test("keeps the line breaks and tabs of the code and the output, and drops other control characters", () => {
    render(
      <EvalCard
        rendererProps={props({
          result: {
            content: [{ type: "text", text: "a" }],
            details: {
              language: "python",
              cells: [
                {
                  index: 0,
                  code: "x = 1\nif x:\n\tprint(x)",
                  language: "python",
                  output: "line one\nline two\u001b[31m red",
                  status: "complete",
                  exitCode: 0,
                },
              ],
            },
          },
        })}
      />,
    );
    expandToolCards();
    const cell = screen.getByTestId("t3-eval-cell-0");
    expect(cell.querySelector("[data-cell-code]")?.textContent).toBe("x = 1\nif x:\n\tprint(x)");
    expect(cell.querySelector("[data-cell-output]")?.textContent).toBe(
      "line one\nline two[31m red",
    );
  });

  test("decodes arguments the model sent as null, as a real call did (reset: null)", () => {
    render(
      <EvalCard
        rendererProps={props({
          args: { language: "py", code: "print(1)", title: null, timeout: null, reset: null },
          result: {
            content: [{ type: "text", text: "1" }],
            details: {
              language: "python",
              cells: [{ index: 0, code: "print(1)", output: "1", status: "complete" }],
            },
          },
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("tool-card-eval-call").getAttribute("data-phase")).toBe("success");
    expect(screen.queryByText(/malformed/i)).toBeNull();
  });

  test("a run that never started shows omp's own reason as the error", () => {
    render(
      <EvalCard
        rendererProps={props({
          isError: true,
          result: {
            content: [
              {
                type: "text",
                text: "Tool was not executed because the run was aborted: Request was aborted.",
              },
            ],
            details: {},
          },
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("alert").textContent).toContain(
      "Tool was not executed because the run was aborted: Request was aborted.",
    );
  });
});
