import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { ReadCard } from "./read";

afterEach(() => cleanup());

const ARGS = { path: "/workspace/src/index.ts", offset: 4, limit: 2 };

function rendererProps(result: unknown, args: unknown = ARGS): ToolRendererProps {
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

/** omp's real result: `{ content: [{ type: "text", text }], details }`. */
function props(details: unknown, text = "", args: unknown = ARGS): ToolRendererProps {
  return rendererProps({ content: [{ type: "text", text }], details }, args);
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

  test("a real file read shows its lines from details.displayContent, never 'No displayable content'", () => {
    // The shape of a real result: the lines are in details.displayContent, the text is a notice.
    render(
      <ReadCard
        rendererProps={props(
          {
            totalLines: 97,
            displayContent: {
              text: 'import { A } from "./a";\nexport const b = 1;',
              startLine: 9,
              lineNumbers: [9, 10],
            },
            fileSize: 3409,
            truncation: { truncated: true, truncatedBy: "lines", totalLines: 89, outputLines: 80 },
            meta: { source: { type: "file", value: "/workspace/src/index.ts" } },
          },
          "[shaken ~1352 tokens — recover: artifact://11902 (region 301)]",
        )}
      />,
    );
    expect(document.querySelector("[data-code-view]")?.textContent).toContain(
      'import { A } from "./a";',
    );
    // The real truncation record says 89 lines in all and 80 shown: nine are left out.
    expect(screen.getByText("Output shortened; omitted 9 lines")).toBeTruthy();
    expect(screen.queryByText("No displayable content")).toBeNull();
  });

  test("a real result with only text (a database summary) shows that text", () => {
    render(
      <ReadCard
        rendererProps={props(
          { resolvedPath: "/home/user/.omp/agent/models.db", meta: { source: { type: "file" } } },
          "model_cache (36 rows)",
          { path: "/home/user/.omp/agent/models.db" },
        )}
      />,
    );
    expect(screen.getByText("model_cache (36 rows)")).toBeTruthy();
    expect(screen.queryByText("No displayable content")).toBeNull();
  });

  test("a real directory listing shows its entries under 'Directory listing'", () => {
    render(
      <ReadCard
        rendererProps={props(
          { isDirectory: true, resolvedPath: "/workspace/src" },
          "components/\nindex.ts\nutil.ts",
          { path: "/workspace/src" },
        )}
      />,
    );
    expect(screen.getByText("Directory listing")).toBeTruthy();
    expect(screen.getByText(/index\.ts/).textContent).toContain("util.ts");
  });

  test("with neither lines nor text it says so plainly", () => {
    render(<ReadCard rendererProps={props({ resolvedPath: "/workspace/empty.txt" })} />);
    expect(screen.getByText("No displayable content")).toBeTruthy();
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
          truncation: { truncated: true, truncatedBy: "lines", totalLines: 100, outputLines: 96 },
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

  test("keeps a running read in the U3 lifecycle shell and shows the raw partial text", () => {
    const running = rendererProps("still reading");
    render(<ReadCard rendererProps={{ ...running, status: { type: "running" } as const }} />);
    expect(screen.getByRole("button", { name: "read: Running" })).toBeTruthy();
    expect(screen.getAllByText("still reading").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("turns malformed details into an open typed error state", () => {
    render(<ReadCard rendererProps={props("not-an-object")} />);
    expect(screen.getByRole("alert").textContent).toContain("Malformed read details");
    expect(screen.getByRole("button", { name: "read: Error" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
