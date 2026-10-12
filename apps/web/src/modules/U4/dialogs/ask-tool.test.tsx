import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { U4_REAL_RESULTS } from "../fixtures/real-results";
import { AskToolRenderer } from "./ask-result";

afterEach(cleanup);

/** Renders a recorded ask result and returns it, so each check reads what the fixture says it shows. */
function renderRecorded(name: string) {
  const sample = U4_REAL_RESULTS.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`no recorded ask sample named ${name}`);
  render(
    <AskToolRenderer
      {...({
        type: "tool-call",
        toolCallId: "u4-ask-real",
        toolName: sample.toolName,
        args: sample.args,
        argsText: JSON.stringify(sample.args),
        result: sample.result,
        isError: sample.isError,
        status: { type: "complete" },
      } as unknown as ToolRendererProps)}
    />,
  );
  expandToolCards();
  return sample;
}

describe("AskToolRenderer on recorded results", () => {
  test("a chosen option is shown under its question", () => {
    const sample = renderRecorded("ask: one option chosen");
    const rows = screen.getByTestId("u4-ask-tool-answers");
    expect(rows.querySelectorAll("dt")).toHaveLength(1);
    expect(rows.querySelector("dt")?.textContent).toBe(sample.shows[0]);
    expect(rows.querySelector("dd")?.textContent).toBe(sample.shows[1]);
  });

  test("several questions keep each answer with its own question, in order", () => {
    const sample = renderRecorded("ask: several questions answered");
    const rows = screen.getByTestId("u4-ask-tool-answers");
    expect(Array.from(rows.querySelectorAll("dt"), (term) => term.textContent)).toEqual([
      sample.shows[0],
      sample.shows[2],
    ]);
    expect(Array.from(rows.querySelectorAll("dd"), (answer) => answer.textContent)).toEqual([
      sample.shows[1],
      sample.shows[3],
    ]);
  });

  test("a call omp skipped shows its reason once, in the error line, and no answer rows", () => {
    const sample = renderRecorded("ask: skipped before it ran");
    expect(screen.queryByTestId("u4-ask-tool-answers")).toBeNull();
    const reason = sample.shows[0] ?? "";
    const alerts = screen
      .getAllByRole("alert")
      .filter((alert) => alert.textContent?.includes(reason));
    expect(alerts).toHaveLength(1);
  });
});
