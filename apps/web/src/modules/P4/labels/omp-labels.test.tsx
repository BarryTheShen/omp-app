import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { fixtureSnapshot, OmpSessionBuilder } from "../selector/omp-session-fixture";
import { LABELS_READ_ONLY_NOTICE } from "../selector/tree-selector-model";
import { createP4LabelsViewModel } from "./model";
import { P4LabelsView } from "./view";

afterEach(cleanup);

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

describe("P4 labels through the real port", () => {
  test("omp's label entries reach the view as their text and the time of the entry they mark, and a clear is not listed", async () => {
    // omp writes a label entry that names the entry it labels; an undefined label removes it.
    const session = new OmpSessionBuilder();
    const plan = session.user("Plan the migration");
    session.assistant("Here is a plan.");
    const ship = session.user("Ship it");
    const draft = session.user("A draft");
    session.label(plan, "Review checkpoint");
    session.label(ship, "Ship it");
    session.label(draft, "Draft");
    session.label(draft, undefined);
    const fixture = session.build();

    const snapshot = await fixtureSnapshot(fixture);
    render(<P4LabelsView model={createP4LabelsViewModel(snapshot)} />);

    const section = screen.getByRole("region", { name: "Labels" });
    const list = within(section).getByRole("list", { name: "Labels" });
    expect(within(list).getByText("Review checkpoint")).toBeTruthy();
    expect(within(list).getByText("Ship it")).toBeTruthy();
    expect(within(section).queryByText("Draft")).toBeNull();
    expect(within(section).getByText("2 labels")).toBeTruthy();
    const planWritten = fixture.entries.find((entry) => entry.id === plan)?.timestamp;
    expect(planWritten).toBeDefined();
    expect(list.textContent).toContain(`Entry from ${WHEN.format(new Date(planWritten ?? ""))}`);
    expect(within(section).getAllByText(LABELS_READ_ONLY_NOTICE)).toHaveLength(1);
  });
});
