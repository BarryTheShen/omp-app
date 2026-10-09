import { EntryId } from "@omp-app/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ReadOnlyTreeLabel, TreeNode, TreeSnapshot } from "../contract";
import { LABELS_READ_ONLY_NOTICE } from "../selector/tree-selector-model";
import { createP4LabelsViewModel } from "./model";
import { P4LabelsView } from "./view";

afterEach(cleanup);

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const WRITTEN = "2026-10-06T07:00:00.000Z";

function label(target: string, text: string | null): ReadOnlyTreeLabel {
  return {
    targetId: EntryId.parse(target),
    text,
    editable: false,
    disabledReason: "Labels can't be changed here.",
  };
}

function entry(id: string, timestamp: string): TreeNode {
  return {
    entry: { type: "message", id: EntryId.parse(id), parentId: null, timestamp },
    children: [],
  };
}

function model(
  labels: readonly ReadOnlyTreeLabel[],
  tree: readonly TreeNode[],
  labelsCapability: TreeSnapshot["labelsCapability"],
) {
  return createP4LabelsViewModel({ labels, labelsCapability, tree });
}

describe("P4 read-only labels view", () => {
  test("shows each label's text and when its entry was written, and states the reason once", () => {
    render(
      <P4LabelsView
        model={model(
          [label("entry-checkpoint", "Review checkpoint"), label("entry-ship", "Ship it")],
          [entry("entry-checkpoint", WRITTEN), entry("entry-ship", WRITTEN)],
          "unavailable",
        )}
      />,
    );

    const section = screen.getByRole("region", { name: "Labels" });
    const list = within(section).getByRole("list", { name: "Labels" });
    expect(within(list).getByText("Review checkpoint")).toBeTruthy();
    expect(within(list).getByText("Ship it")).toBeTruthy();
    expect(list.textContent).toContain(`Entry from ${WHEN.format(new Date(WRITTEN))}`);
    expect(list.textContent).not.toContain("entry-checkpoint");
    expect(list.textContent).not.toContain(LABELS_READ_ONLY_NOTICE);
    expect(within(section).getByText("2 labels")).toBeTruthy();
    expect(within(section).getAllByText(LABELS_READ_ONLY_NOTICE)).toHaveLength(1);
  });

  test("the disabled edit button is described by the paragraph that states the reason", () => {
    render(
      <P4LabelsView
        model={model(
          [label("entry-ship", "Ship it")],
          [entry("entry-ship", WRITTEN)],
          "unavailable",
        )}
      />,
    );

    const section = screen.getByRole("region", { name: "Labels" });
    const edit = within(section).getByRole("button", { name: "Edit labels" });
    const reason = within(section).getByText(LABELS_READ_ONLY_NOTICE);
    expect(edit).toHaveProperty("disabled", true);
    expect(reason.id).not.toBe("");
    expect(edit.getAttribute("aria-describedby")).toBe(reason.id);
  });

  test("when the tree already states the reason, the labels view leaves it out and describes nothing", () => {
    render(
      <P4LabelsView
        model={model(
          [label("entry-ship", "Ship it")],
          [entry("entry-ship", WRITTEN)],
          "unavailable",
        )}
        showReason={false}
      />,
    );

    const section = screen.getByRole("region", { name: "Labels" });
    const edit = within(section).getByRole("button", { name: "Edit labels" });
    expect(edit).toHaveProperty("disabled", true);
    expect(section.textContent).not.toContain(LABELS_READ_ONLY_NOTICE);
    expect(edit.getAttribute("aria-describedby")).toBeNull();
    expect(edit.getAttribute("title")).toBeNull();
  });

  test("an empty list says where its labels come from, and keeps editing disabled", () => {
    render(<P4LabelsView model={model([], [], "available")} />);

    const section = screen.getByRole("region", { name: "Labels" });
    expect(within(section).getByText("No labels yet.")).toBeTruthy();
    expect(within(section).getByText("Labels added in omp's terminal show up here.")).toBeTruthy();
    expect(within(section).queryByRole("list")).toBeNull();
    const edit = within(section).getByRole("button", { name: "Edit labels" });
    expect(edit).toHaveProperty("disabled", true);
    expect(within(section).getByText("Labels are read-only in this app.")).toBeTruthy();
  });
});
