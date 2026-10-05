import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { ReadCard } from "./read";

afterEach(() => cleanup());

function props(
  result: unknown,
  args: unknown = { path: "/workspace/src/index.ts", offset: 4, limit: 2 },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "read-1",
    toolName: "read",
    args,
    argsText: JSON.stringify(args),
    result,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

describe("ReadCard", () => {
  test("renders a middle-ellipsized target, selector chip and line-numbered content", () => {
    render(
      <ReadCard
        rendererProps={props({
          kind: "file",
          displayTarget: "src/index.ts",
          displayContent: { text: "const a = 1;\nconst b = 2;", startLine: 5 },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "read: Complete" }).textContent).toContain(
      "src/index.ts",
    );
    expect(screen.getByText("lines 5–6")).toBeTruthy();
    expect(screen.getByText("const a = 1;")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
  });

  test("shows grouped read metadata and truncation details", () => {
    render(
      <ReadCard
        groupedReads={[
          { toolCallId: "read-1", details: { kind: "file", displayTarget: "a.ts" } },
          { toolCallId: "read-2", details: { kind: "file", displayTarget: "a.ts" } },
        ]}
        rendererProps={props({
          kind: "file",
          displayTarget: "a.ts",
          displayContent: { text: "one", startLine: 1 },
          truncation: { direction: "tail", reason: "lines", omittedLines: 4 },
          suffixResolution: "Resolved via .tsx suffix",
          meta: { diagnostics: [{ message: "Binary fallback used" }] },
        })}
      />,
    );

    expect(screen.getByText("2 reads grouped")).toBeTruthy();
    expect(screen.getByText("Output shortened; omitted 4 lines")).toBeTruthy();
    expect(screen.getByText("Resolved via .tsx suffix")).toBeTruthy();
    expect(screen.getByText("Binary fallback used")).toBeTruthy();
  });

  test("dispatches URL reads to the injected T4 renderer", () => {
    render(
      <ReadCard
        rendererProps={props({
          kind: "url",
          url: "skill://review",
          displayTarget: "skill://review",
        })}
        urlRenderer={({ details }) => <div data-testid="url-renderer">{details.url}</div>}
      />,
    );
    expect(screen.getByTestId("url-renderer").textContent).toBe("skill://review");
  });

  test("keeps URL metadata visible when the seam is unavailable", () => {
    render(<ReadCard rendererProps={props({ kind: "url", url: "skill://review" })} />);
    expect(screen.getByText("URL renderer unavailable")).toBeTruthy();
  });

  test("renders directory and image states without reading local paths", () => {
    const first = render(
      <ReadCard rendererProps={props({ kind: "file", isDirectory: true, displayTarget: "src" })} />,
    );
    expect(screen.getByText("Directory listing")).toBeTruthy();
    first.unmount();

    const second = render(
      <ReadCard
        rendererProps={props({
          kind: "file",
          contentType: "image/png",
          displayTarget: "image.png",
        })}
      />,
    );
    expect(screen.getByText("Image preview supplied by the read result.")).toBeTruthy();
    second.unmount();

    const third = render(
      <ReadCard
        rendererProps={props({
          kind: "file",
          contentType: "image/png",
          displayTarget: "image.png",
          data: "iVBORw0KGgo=",
        })}
      />,
    );
    expect(screen.getByRole("img", { name: "image.png" }).getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    third.unmount();
    render(
      <ReadCard
        rendererProps={props({
          kind: "file",
          contentType: "application/octet-stream",
          displayTarget: "archive.bin",
          fileSize: 7,
        })}
      />,
    );
    expect(screen.getByTestId("t1-read-binary").textContent).toContain("7 bytes");
  });

  test("keeps running and raw partial states in the U3 lifecycle shell", () => {
    const running = props("still reading");
    render(<ReadCard rendererProps={{ ...running, status: { type: "running" } as const }} />);
    expect(screen.getByRole("button", { name: "read: Running" })).toBeTruthy();
    expect(screen.getByText("still reading")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("turns malformed details into an open typed error state", () => {
    render(<ReadCard rendererProps={props("not-an-object")} />);
    expect(screen.getByRole("alert").textContent).toContain("Malformed read details");
    expect(screen.getByText("not-an-object")).toBeTruthy();
    expect(screen.getByRole("button", { name: "read: Error" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
