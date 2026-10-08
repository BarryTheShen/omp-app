import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import type { RealToolResult } from "../U3/tool-card/real-result";
import { T4_WEB_FETCH_REAL_RESULTS } from "./fixtures/web-fetch-real-results";
import { WebFetchRenderer } from "./web-fetch";

afterEach(cleanup);

/** The props a recorded web_fetch call gives its card. */
function recordedProps(sample: RealToolResult): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "t4-web-fetch-real",
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
    result: sample.result,
    isError: sample.isError,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

describe("WebFetchRenderer", () => {
  test("shows the page the call asked for and the text omp returned", () => {
    const page = T4_WEB_FETCH_REAL_RESULTS.find((sample) => !sample.isError);
    if (page === undefined) throw new Error("no recorded web_fetch page");
    render(<WebFetchRenderer {...recordedProps(page)} />);
    expect(screen.getByTestId("t4-web-fetch")).toBeTruthy();
    expect(screen.getByText("example.test/page-1")).toBeTruthy();
    expect(screen.getByTestId("t4-url-text").textContent).toContain("Scrubbed page heading");
  });

  test("a failed fetch says why once, in the banner, and the line count is singular", () => {
    const failure = T4_WEB_FETCH_REAL_RESULTS.find((sample) => sample.isError);
    if (failure === undefined) throw new Error("no recorded web_fetch failure");
    render(<WebFetchRenderer {...recordedProps(failure)} />);
    expect(screen.getAllByText("Fetch timed out while retrieving content")).toHaveLength(1);
    expect(screen.queryByTestId("t4-url-text")).toBeNull();
    expect(screen.getByText("1 line")).toBeTruthy();
  });
});
