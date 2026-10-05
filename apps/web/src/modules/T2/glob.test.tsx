import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GlobCard } from "./glob";

afterEach(cleanup);

function props(
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  const args = { pattern: "**/*.ts", path: "src", hidden: false, gitignore: true, limit: 20 };
  return {
    type: "tool-call",
    toolCallId: "glob-1",
    toolName: "glob",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

describe("GlobCard", () => {
  test("renders pattern/scope summary and safe read links for matched files", () => {
    render(
      <GlobCard
        rendererProps={props({
          fileCount: 2,
          files: [{ path: "src/a.ts", target: "src/a.ts" }, { path: "src/b.ts" }],
        })}
      />,
    );
    expect(screen.getByText("Scope: src")).toBeTruthy();
    expect(screen.getByRole("link", { name: "src/a.ts" }).getAttribute("href")).toBe(
      "#read:src%2Fa.ts",
    );
    expect(screen.getByRole("link", { name: "src/b.ts" })).toBeTruthy();
  });

  test("shows missing paths and limit/truncation guidance", () => {
    render(
      <GlobCard
        rendererProps={props({
          fileCount: 20,
          files: [],
          missingPaths: ["missing/dir"],
          resultLimitReached: true,
        })}
      />,
    );
    expect(screen.getByTestId("t2-glob-missing").textContent).toContain("missing/dir");
    expect(screen.getByTestId("t2-glob-limit").textContent).toContain("20");
  });

  test("keeps running scope visible while hiding raw argument/result blocks", () => {
    render(<GlobCard rendererProps={props(undefined, { type: "running" })} />);
    expect(screen.getByTestId("t2-glob-pattern")).toBeTruthy();
    expect(screen.getByTestId("tool-card-glob-1").className).toContain(
      "data-slot='u3-tool-card-args",
    );
    expect(screen.getByTestId("tool-card-glob-1").className).toContain(
      "data-slot='u3-tool-card-result",
    );
  });
});
