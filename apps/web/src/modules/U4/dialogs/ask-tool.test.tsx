import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { U4_REAL_RESULTS } from "../fixtures/real-results";
import { AskToolRenderer, askSummary } from "./ask-result";

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

describe("the ask card's one-line summary", () => {
  test("one question with several choices reads as its choices, and several questions count their answers", () => {
    expect(
      askSummary([{ question: "Which tools should run?", answers: ["Read", "Grep"] }], false),
    ).toBe("Read, Grep");
    expect(askSummary([{ question: "Which database?", answers: ["SQLite"] }], false)).toBe(
      "SQLite",
    );
    expect(
      askSummary(
        [
          { question: "Which database?", answers: ["SQLite"] },
          { question: "Which tools should run?", answers: ["Read", "Bash"] },
        ],
        false,
      ),
    ).toBe("3 answers returned");
  });

  test("a question still open with no answer says the app waits for the person's answer", () => {
    expect(askSummary([], true)).toBe("Waiting for the person's answer");
  });

  test("a question that ended with no answer says No answer returned", () => {
    expect(askSummary([], false)).toBe("No answer returned");
  });

  test("a question answered with none ticked reads None", () => {
    expect(askSummary([{ question: "Which tools should run?", answers: [] }], false)).toBe("None");
  });
});

describe("the card's line while a question has no answer", () => {
  test("a question still open reads that the app waits for the person's answer", () => {
    render(
      <AskToolRenderer
        {...({
          type: "tool-call",
          toolCallId: "u4-ask-open",
          toolName: "ask",
          args: {},
          argsText: "{}",
          status: { type: "running" },
        } as unknown as ToolRendererProps)}
      />,
    );
    expect(screen.getByText("Waiting for the person's answer")).toBeTruthy();
    expect(screen.queryByText("No answer returned")).toBeNull();
  });

  test("a call that ended with no answer still reads No answer returned", () => {
    renderRecorded("ask: skipped before it ran");
    expect(screen.getByText("No answer returned")).toBeTruthy();
    expect(screen.queryByText("Waiting for the person's answer")).toBeNull();
  });
});
