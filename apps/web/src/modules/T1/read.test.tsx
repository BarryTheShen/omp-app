import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { RESULT_IMAGE_MAX_BYTES } from "../U3/tool-card/result-image";
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
    expandToolCards();
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
    expandToolCards();
    expect(document.querySelector("[data-code-view]")?.textContent).toContain(
      'import { A } from "./a";',
    );
    // The real truncation record says 89 lines in all and 80 shown: nine are left out.
    expect(screen.getByText("Output shortened; omitted 9 lines")).toBeTruthy();
    expect(screen.queryByText("No displayable content")).toBeNull();
  });

  test("a cut read says where it continues, from the record's next line", () => {
    // The shape of a real head cut: 24 of 30 lines shown, and omp's record names line 25 as the next to read.
    render(
      <ReadCard
        rendererProps={props({
          displayTarget: "notes.md",
          displayContent: {
            text: Array.from({ length: 24 }, (_, index) => `note ${index + 1}`).join("\n"),
            startLine: 1,
          },
          truncation: {
            truncated: true,
            direction: "head",
            truncatedBy: "lines",
            totalLines: 30,
            outputLines: 24,
          },
          meta: {
            truncation: { direction: "head", totalLines: 30, outputLines: 24, nextOffset: 25 },
          },
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Output shortened; omitted 6 lines")).toBeTruthy();
    expect(screen.getByText("Continue at line 25")).toBeTruthy();
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
    expandToolCards();
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
    expandToolCards();
    expect(screen.getByText("Directory listing")).toBeTruthy();
    expect(screen.getByTestId("t1-read-text").textContent).toContain("index.ts");
    expect(screen.getByTestId("t1-read-text").textContent).toContain("util.ts");
  });

  test("with neither lines nor text it says so plainly", () => {
    render(<ReadCard rendererProps={props({ resolvedPath: "/workspace/empty.txt" })} />);
    expandToolCards();
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
          suffixResolution: { from: "a", to: "a.tsx" },
          meta: { diagnostics: { summary: "1 warning(s)", messages: ["Binary fallback used"] } },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByText("2 reads grouped")).toBeTruthy();
    expect(screen.getByText("Output shortened; omitted 4 lines")).toBeTruthy();
    expect(
      screen.getByText("Path 'a' not found; resolved to 'a.tsx' via suffix match"),
    ).toBeTruthy();
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
    expandToolCards();
    expect(screen.getByText("URL renderer unavailable")).toBeTruthy();
  });

  test("draws the image omp returned in the result, with a full-size toggle", () => {
    const { unmount } = render(
      <ReadCard
        rendererProps={rendererProps(
          {
            content: [
              { type: "text", text: "Read image file [image/png]" },
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
            details: {
              fileSize: 9,
              meta: { source: { type: "path", value: "/workspace/pixel.png" } },
            },
          },
          { path: "/workspace/pixel.png" },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("img", { name: "/workspace/pixel.png" }).getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(screen.getByText("Read image file [image/png]")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Show full size" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show smaller" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    unmount();
  });

  test("says in plain words when an image is missing, too large or of a type it cannot draw", () => {
    const missing = render(
      <ReadCard
        rendererProps={rendererProps(
          {
            content: [{ type: "text", text: "Read image file [image/png]" }],
            details: { fileSize: 9 },
          },
          { path: "/workspace/pixel.png" },
        )}
      />,
    );
    expandToolCards();
    expect(
      screen.getByText("The image is not in omp's result, so it cannot be shown."),
    ).toBeTruthy();
    expect(missing.container.querySelector("img")).toBeNull();
    missing.unmount();

    const tooLargeData = "A".repeat(Math.ceil(((RESULT_IMAGE_MAX_BYTES + 1) * 4) / 3 / 4) * 4);
    const tooLarge = render(
      <ReadCard
        rendererProps={rendererProps(
          {
            content: [{ type: "image", data: tooLargeData, mimeType: "image/png" }],
            details: { fileSize: RESULT_IMAGE_MAX_BYTES + 1 },
          },
          { path: "/workspace/big.png" },
        )}
      />,
    );
    expandToolCards();
    expect(
      screen.getByText(
        "This image is 4.0 MB. This card shows images up to 4 MB, so it is not drawn here.",
      ),
    ).toBeTruthy();
    expect(tooLarge.container.querySelector("img")).toBeNull();
    tooLarge.unmount();

    const svg = render(
      <ReadCard
        rendererProps={rendererProps(
          {
            content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/svg+xml" }],
            details: { fileSize: 9 },
          },
          { path: "/workspace/icon.svg" },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("This type of image cannot be shown here.")).toBeTruthy();
    expect(svg.container.querySelector("img")).toBeNull();
  });

  test("says a saved picture the history could not load is not in the chat, with no image", () => {
    const { container, unmount } = render(
      <ReadCard
        rendererProps={rendererProps(
          {
            content: [
              { type: "image", data: `blob:sha256:${"a".repeat(64)}`, mimeType: "image/png" },
            ],
            details: { fileSize: 9 },
          },
          { path: "/workspace/saved.png" },
        )}
      />,
    );
    expandToolCards();
    expect(
      screen.getByText(
        "This image is not in the saved chat: it is over the 4 MB this card shows, or its saved copy is missing.",
      ),
    ).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    unmount();
  });

  test("keeps a binary read as a size note, not a picture", () => {
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
    expandToolCards();
    expect(screen.getByTestId("t1-read-binary").textContent).toContain("7 bytes");
  });

  test("keeps a running read in the U3 lifecycle shell and shows the raw partial text", () => {
    const running = rendererProps("still reading");
    render(<ReadCard rendererProps={{ ...running, status: { type: "running" } as const }} />);
    expandToolCards();
    expect(screen.getByRole("button", { name: "read: Running" })).toBeTruthy();
    expect(screen.getAllByText("still reading").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("turns malformed details into a typed error state that shows once the card opens", () => {
    render(<ReadCard rendererProps={props("not-an-object")} />);
    expandToolCards();
    expect(screen.getByRole("alert").textContent).toContain("Malformed read details");
    expect(screen.getByRole("button", { name: "read: Error" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
