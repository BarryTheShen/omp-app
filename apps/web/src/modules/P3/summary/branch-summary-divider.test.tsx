import type { OmpWire } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { BranchSummaryDivider } from "./index";

const message: OmpWire.BranchSummaryMessage = {
  role: "branchSummary",
  summary: "## Kept branch\n\n- Keep the original conversation\n\n[unsafe](javascript:alert(1))",
  fromId: "entry-parent-42",
  timestamp: 1_759_600_000_000,
};

afterEach(cleanup);

function disclosure(container: HTMLElement): HTMLDetailsElement {
  const details = container.querySelector("details");
  if (!details) throw new Error("the divider has no disclosure");
  return details;
}

describe("P3 branch summary divider", () => {
  test("keeps the source entry identity and reveals U1 compact Markdown on demand", () => {
    const { container } = render(<BranchSummaryDivider message={message} />);

    const divider = container.querySelector("[data-p3-branch-summary-divider]");
    expect(divider?.getAttribute("data-from-id")).toBe("entry-parent-42");
    expect(screen.getByText("Branch summary")).toBeTruthy();
    // The summary is in the DOM while the row is closed, so only the open state shows it is hidden.
    expect(disclosure(container).open).toBe(false);

    fireEvent.click(screen.getByText("Branch summary"));

    expect(disclosure(container).open).toBe(true);
    expect(screen.getByRole("heading", { name: "Kept branch" })).toBeTruthy();
    expect(screen.getByText("Keep the original conversation")).toBeTruthy();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  test("the chevron turns and the summary reads in the foreground colour when open", async () => {
    const { container } = render(<BranchSummaryDivider message={message} />);
    const chevron = container.querySelector("summary > svg:last-child");
    expect(chevron?.getAttribute("class")).not.toContain("rotate-180");

    fireEvent.click(screen.getByText("Branch summary"));

    // The browser queues the toggle event after the click, so the chevron turns on a later tick.
    await waitFor(() => expect(chevron?.getAttribute("class")).toContain("rotate-180"));
    expect(container.querySelector("details > div")?.className).toContain("text-foreground");
  });

  test("renders a safe empty-summary state without exposing the source id", () => {
    const emptyMessage: OmpWire.BranchSummaryMessage = {
      ...message,
      fromId: "entry-with-sensitive-label",
      summary: "   ",
    };
    const { container } = render(<BranchSummaryDivider message={emptyMessage} />);

    expect(screen.getByText("No branch summary was provided.")).toBeTruthy();
    expect(container.textContent).not.toContain("entry-with-sensitive-label");
    expect(container.querySelector("[data-from-id='entry-with-sensitive-label']")).toBeTruthy();
  });
});
