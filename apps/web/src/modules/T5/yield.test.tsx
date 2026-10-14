import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import { YieldToolRenderer } from "./yield";
import { YIELD_FIXTURES, type YieldFixture, yieldRendererProps } from "./yield-fixtures";

afterEach(() => cleanup());

function renderFixture(id: string) {
  const fixture: YieldFixture | undefined = YIELD_FIXTURES.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`No yield fixture named ${id}`);
  return render(<YieldToolRenderer {...yieldRendererProps(fixture)} />);
}

function phaseOf(id: string): string | null {
  return screen.getByTestId(`tool-card-yield-${id}`).getAttribute("data-phase");
}

describe("T5.5 yield submission card", () => {
  test("a finished submission starts as one line: its output shows only after the card opens", () => {
    renderFixture("success-data");

    expect(phaseOf("success-data")).toBe("success");
    expect(screen.queryByTestId("t5-yield-output")).toBeNull();
    expandToolCards();
    expect(screen.getByTestId("t5-yield-output").textContent).toContain("Three findings");
  });

  test("an incremental section shows its label and the raw result behind Raw details, with copy", () => {
    renderFixture("section");
    expandToolCards();

    expect(screen.getByText("Submitted sections")).toBeTruthy();
    expect(screen.getByText("findings")).toBeTruthy();
    expect(screen.getByText("1 section submitted")).toBeTruthy();
    const raw = screen
      .getByTestId("tool-card-yield-section")
      .querySelector('[data-slot="u3-tool-card-result"]');
    expect(raw?.textContent).toContain('"severity"');
    expect(screen.getByRole("button", { name: "Copy raw result" })).toBeTruthy();
  });

  test("a last-turn submission says the last assistant response was the result", () => {
    renderFixture("last-turn");
    expandToolCards();

    expect(screen.getByText("Uses the last assistant response")).toBeTruthy();
    expect(screen.getByText("The last assistant response was used as the result.")).toBeTruthy();
    expect(screen.queryByText("No submitted output")).toBeNull();
  });

  test("an aborted submission is an error, and the worker's reason is the banner", () => {
    renderFixture("aborted");
    expandToolCards();

    expect(phaseOf("aborted")).toBe("error");
    expect(screen.getByText("Submission failed")).toBeTruthy();
    expect(screen.getAllByText("The shard is missing a row.").length).toBeGreaterThan(0);
  });

  test("a section that does not match the schema is an error with omp's words", () => {
    renderFixture("schema-error");
    expandToolCards();

    expect(phaseOf("schema-error")).toBe("error");
    expect(screen.getByText("Submission failed")).toBeTruthy();
    expect(screen.getAllByText(/does not match schema/).length).toBeGreaterThan(0);
    // The reason is the banner: an error submission has no output to say it is missing.
    expect(screen.queryByText("No submitted output")).toBeNull();
  });

  test("a validation override says the result was accepted anyway", () => {
    renderFixture("validation-override");
    expandToolCards();

    expect(screen.getByText("Accepted after validation override")).toBeTruthy();
    expect(
      screen.getByText("The result was accepted after schema validation was overridden."),
    ).toBeTruthy();
  });

  test("a workpool item shows its number, not its id, and its summary says which item it is", () => {
    renderFixture("workpool-item");
    expandToolCards();

    expect(screen.getByText("Item 2")).toBeTruthy();
    expect(screen.queryByText("Submitted sections")).toBeNull();
    expect(screen.queryByText("item-2")).toBeNull();
    expect(screen.getByText("Item 2 submitted")).toBeTruthy();
    expect(phaseOf("workpool-item")).toBe("success");
  });

  test("the last workpool item says all items were submitted", () => {
    renderFixture("workpool-complete");
    expandToolCards();

    expect(screen.getByText("All items submitted")).toBeTruthy();
    expect(screen.getByText("All items were submitted.")).toBeTruthy();
    expect(screen.getByText("Item 3")).toBeTruthy();
  });

  test("a workpool item the worker could not do is an error, with its reason", () => {
    renderFixture("workpool-item-error");
    expandToolCards();

    expect(phaseOf("workpool-item-error")).toBe("error");
    expect(screen.getAllByText("The shard is missing a row.").length).toBeGreaterThan(0);
  });

  test("a call a steering message skipped is cancelled, and omp's full words are the banner", () => {
    renderFixture("steering-skip");
    expandToolCards();

    expect(phaseOf("steering-skip")).toBe("cancelled");
    expect(screen.getByText("Submission ended early")).toBeTruthy();
    expect(
      screen.getAllByText(/Skipped due to pending parent steering message/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/After the steering message is handled/).length).toBeGreaterThan(0);
  });

  test("a call a steering message interrupted after it started is cancelled too", () => {
    renderFixture("interrupted-skip");
    expandToolCards();

    expect(phaseOf("interrupted-skip")).toBe("cancelled");
  });

  test("a person's Stop is cancelled, and a provider stream error is an error with its reason", () => {
    renderFixture("stop-aborted");
    expandToolCards();
    expect(phaseOf("stop-aborted")).toBe("cancelled");
    expect(screen.getAllByText("Tool execution was aborted.").length).toBeGreaterThan(0);
  });

  test("a provider stream error before the submission ran is an error, with the reason", () => {
    renderFixture("stop-error");
    expandToolCards();

    expect(phaseOf("stop-error")).toBe("error");
    expect(
      screen.getAllByText(/the provider stream ended with an error before the tool could run/)
        .length,
    ).toBeGreaterThan(0);
  });

  test("arguments that are not valid JSON are an error with the reason omp gave", () => {
    renderFixture("parse-error");
    expandToolCards();

    expect(phaseOf("parse-error")).toBe("error");
    expect(screen.getAllByText(/Tool call arguments are not valid JSON/).length).toBeGreaterThan(0);
  });

  test("a long text result shows its first lines and says how much was cut", () => {
    renderFixture("large-text");
    expandToolCards();

    expect(screen.getByText(/Showing 12 of 30 lines; \d+ characters omitted\./)).toBeTruthy();
    expect(screen.getByText(/The full output is in Raw details\./)).toBeTruthy();
  });

  test("a submission still arriving says it is waiting for output", () => {
    renderFixture("running");
    expandToolCards();

    expect(phaseOf("running")).toBe("running");
    expect(screen.getByText("Waiting for submitted output.")).toBeTruthy();
  });

  test("details with an unknown status are an error card that keeps the raw result", () => {
    renderFixture("malformed");
    expandToolCards();

    expect(phaseOf("malformed")).toBe("error");
    expect(screen.getByText("The result is invalid; raw output is available.")).toBeTruthy();
  });

  test("a call with no recorded result reads as no result recorded, with no submitted output", () => {
    render(
      <YieldToolRenderer
        {...yieldRendererProps({
          id: "unrecorded",
          title: "A call with no result",
          args: { data: "never recorded" },
          status: "complete",
        })}
      />,
    );

    expect(phaseOf("unrecorded")).toBe("unrecorded");
    expect(screen.getByText("No result recorded")).toBeTruthy();
    expect(screen.queryByText("No submitted output")).toBeNull();
  });

  test("offers no control that submits or answers from a read-only nested card", () => {
    renderFixture("success-data");
    expandToolCards();

    // The disclosure line names the submission in its summary, so it is not a control; every other button is checked.
    const labels = screen
      .queryAllByRole("button")
      .filter((button) => button.getAttribute("data-slot") !== "u3-tool-card-trigger")
      .map((button) => button.textContent ?? "");
    expect(labels.filter((label) => /submit|send|answer|approve|steer|retry/i.test(label))).toEqual(
      [],
    );
  });
});
