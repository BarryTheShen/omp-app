import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ExecutionRecord } from "@/modules/U2/execution";
import { ExecutionRow } from "./execution-row";

afterEach(() => cleanup());

const run: ExecutionRecord = {
  id: "entry:thread:bash",
  mode: "bash",
  source: "ls /missing",
  output: "ls: cannot access '/missing': No such file or directory\n",
  cancelled: false,
  truncated: false,
  exitCode: 2,
  excludeFromContext: false,
};

describe("U1 execution row", () => {
  test("shows the command, its output, and how it ended", () => {
    render(<ExecutionRow record={run} />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("Exit code 2")).toBeTruthy();
    expect(screen.getByText("ls /missing")).toBeTruthy();
    expect(screen.getByTestId("u1-execution-output").textContent).toContain(
      "No such file or directory",
    );
    expect(screen.queryByText("Not sent to the model")).toBeNull();
  });

  test("marks a run kept out of the model, and says when the command was cancelled", () => {
    render(
      <ExecutionRow record={{ ...run, cancelled: true, excludeFromContext: true, output: "" }} />,
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Not sent to the model")).toBeTruthy();
    expect(screen.queryByTestId("u1-execution-output")).toBeNull();
  });
});
