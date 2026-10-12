import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { WriteCard } from "./write";

afterEach(() => cleanup());

function rawProps(
  args: unknown,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  isError = false,
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "write-1",
    toolName: "write",
    args,
    argsText: JSON.stringify(args),
    result,
    isError,
    status,
  } as unknown as ToolRendererProps;
}

/** omp's real result: `{ content: [{ type: "text", text }], details }`. */
function props(
  args: unknown,
  details: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  text = "",
  isError = false,
): ToolRendererProps {
  const result = details === undefined ? undefined : { content: [{ type: "text", text }], details };
  return rawProps(args, result, status, isError);
}

describe("WriteCard", () => {
  test("keeps a streamed source preview stable with line numbers and bounded expansion", () => {
    const content = Array.from(
      { length: 24 },
      (_, index) => `export const line${index + 1} = ${index + 1};`,
    ).join("\n");
    render(
      <WriteCard
        rendererProps={props({ path: "src/long.ts", content }, undefined, { type: "running" })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("t1-write-card")).toBeTruthy();
    expect(
      screen
        .getByTestId("t1-write-card")
        .querySelector("[data-slot='t1-write-target']")
        ?.getAttribute("title"),
    ).toBe("src/long.ts");
    expect(
      screen.getByTestId("t1-write-card").querySelector("[data-slot='t1-write-language']")
        ?.textContent,
    ).toBe("typescript");
    expect(screen.getByText("Source preview shortened; 8 lines omitted")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText("export const line24 = 24;")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show full source" }));
    expect(screen.getByText("export const line24 = 24;")).toBeTruthy();
  });

  test("shows settled path, executable and device metadata without treating warnings as errors", () => {
    render(
      <WriteCard
        rendererProps={props(
          { path: "scripts/run.sh", content: "#!/bin/sh\necho ready\n" },
          {
            madeExecutable: true,
            resolvedPath: "/home/user/project/scripts/run.sh",
            xdev: { tool: "recall", mode: "execute", tier: "read" },
            diagnostics: [
              { severity: "warning", path: "scripts/run.sh", line: 2, message: "shellcheck" },
            ],
            meta: {
              truncation: {
                truncated: true,
                direction: "tail",
                truncatedBy: "lines",
                totalLines: 10,
                outputLines: 9,
              },
              artifactId: "artifact-write-1",
              artifactElidedBytes: 24,
            },
          },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByText("Executable")).toBeTruthy();
    expect(screen.getByText("Shebang")).toBeTruthy();
    expect(screen.getByText("recall")).toBeTruthy();
    const bodyText =
      screen.getByTestId("t1-write-card").querySelector("[data-slot='t1-write-body']")
        ?.textContent ?? "";
    expect(bodyText).toContain("shellcheck");
    expect(screen.getByText(/Artifact available:/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Artifact action unavailable" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("a call with nothing written (a job cancelled, a message sent) shows what omp answered, not a wait", () => {
    render(
      <WriteCard
        rendererProps={props(
          { path: "proc://Overlap/kill" },
          { proc: { op: "cancel", jobs: [{ id: "Overlap", status: "cancelled" }] } },
          { type: "complete" },
          "Cancelled background job Overlap.",
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Cancelled background job Overlap.")).toBeTruthy();
    expect(screen.getByText("Background job")).toBeTruthy();
    expect(screen.queryByText("Waiting for source content…")).toBeNull();
    expect(
      screen.getByTestId("t1-write-card").querySelector("[data-slot='t1-write-language']"),
    ).toBeNull();
  });

  test("a still-running call without source says it is waiting for it", () => {
    render(
      <WriteCard
        rendererProps={rawProps({ path: "src/new.ts" }, undefined, { type: "running" })}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Waiting for source content…")).toBeTruthy();
  });

  test("a device call that failed shows omp's reason once, as the error", () => {
    render(
      <WriteCard
        rendererProps={props(
          { path: "xd://recall", content: '{"query":"phone"}' },
          { xdev: { tool: "recall", mode: "execute", tier: "read" } },
          { type: "complete" },
          "recall request failed: The socket connection was closed unexpectedly.",
          true,
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("alert").textContent).toContain(
      "recall request failed: The socket connection was closed unexpectedly.",
    );
    expect(screen.getByTestId("tool-state-chip-error")).toBeTruthy();
  });

  test("uses an image data URL for SVG previews and never mounts SVG markup", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("x")</script><rect width="4" height="4" /></svg>';
    const { container } = render(
      <WriteCard
        rendererProps={props(
          { path: "assets/icon.svg", content: source },
          { resolvedPath: "assets/icon.svg" },
        )}
      />,
    );
    expandToolCards();

    const image = screen.getByRole("img", { name: "assets/icon.svg SVG preview" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(container.querySelector("[data-slot='t1-write-svg-preview'] svg")).toBeNull();
    expect(
      container.querySelector("[data-slot='t1-write-svg-preview']")?.getAttribute("style"),
    ).toContain("linear-gradient");
    expect(
      screen.getByText(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("x")</script><rect width="4" height="4" /></svg>',
      ),
    ).toBeTruthy();
  });

  test("keeps source visible when a typed write result is malformed and surfaces a retry-safe error", () => {
    render(
      <WriteCard
        rendererProps={rawProps({ path: "src/broken.ts", content: "export const value = 1;" }, [
          "not",
          "a",
          "write",
          "detail",
        ])}
      />,
    );
    expandToolCards();

    expect(screen.getByText("export const value = 1;")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Malformed write details");
    expect(screen.getByTestId("tool-state-chip-error")).toBeTruthy();
  });
  test("retains an empty file as a settled zero-line source instead of showing a loading state", () => {
    render(
      <WriteCard
        rendererProps={props({ path: "empty.txt", content: "" }, { resolvedPath: "empty.txt" })}
      />,
    );
    expandToolCards();

    expect(
      screen.getByTestId("t1-write-card").querySelector("[data-slot='t1-write-line-count']")
        ?.textContent,
    ).toBe("0 lines");
    expect(screen.queryByText("Waiting for source content…")).toBeNull();
  });

  test("keeps partial source visible when the tool is cancelled", () => {
    render(
      <WriteCard
        rendererProps={rawProps(
          { path: "src/cancelled.ts", content: "export const partial = true;" },
          "partial output",
          { type: "incomplete", reason: "cancelled" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("tool-state-chip-cancelled")).toBeTruthy();
    expect(screen.getByText("export const partial = true;")).toBeTruthy();
  });
  test("surfaces rejected artifact callbacks instead of leaking a promise", async () => {
    const onOpenArtifact = vi.fn(async () => {
      throw new Error("artifact transport failed");
    });
    render(
      <WriteCard
        onOpenArtifact={onOpenArtifact}
        rendererProps={props(
          { path: "src/large.ts", content: "const source = true;" },
          { meta: { artifactId: "artifact-failure" } },
        )}
      />,
    );
    expandToolCards();

    fireEvent.click(screen.getByRole("button", { name: "Open full artifact" }));
    expect(await screen.findByText("Artifact could not be opened.")).toBeTruthy();
    expect(onOpenArtifact).toHaveBeenCalledOnce();
  });

  test("preserves typed AppFailure and offers raw-source copy through the injected callback", async () => {
    const onCopy = vi.fn(async () => undefined);
    render(
      <WriteCard
        onCopy={onCopy}
        rendererProps={rawProps(
          { path: "src/error.ts", content: "const kept = true;" },
          new AppFailure({ code: "permission", message: "Write denied", retryable: false }),
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("alert").textContent).toContain("Write denied");
    fireEvent.click(screen.getByRole("button", { name: "Copy raw source" }));
    expect(onCopy).toHaveBeenCalledWith("const kept = true;", "code");
  });
});
