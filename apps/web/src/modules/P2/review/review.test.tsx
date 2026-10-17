import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PlanDocument } from "../contract";
import { PlanReviewPanel } from "./index";

const planDocument: PlanDocument = {
  id: "plan-1",
  threadId: "thread-plan" as PlanDocument["threadId"],
  markdown: `# [Plan](https://safe.example)

## [Steps](https://safe.example/steps)

Do the work. Reference: [guide][guide].

\`\`\`md
# Code-only heading
\`\`\`

Setext heading
--------------

Inline raw HTML: <img src=x onerror="alert(1)" />

[guide]: https://guide.example
`,
  sections: [
    { id: "a1-plan", heading: "Plan", start: 0, end: 1 },
    { id: "a1-steps", heading: "Steps", start: 2, end: 5 },
    { id: "a1-setext", heading: "Setext heading", start: 10, end: 12 },
  ],
  annotations: [],
  status: "review",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => cleanup());

describe("PlanReviewPanel", () => {
  test("builds the table of contents from safe rendered headings and focuses a linked heading", async () => {
    const scrollIntoView = vi.fn();
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      render(<PlanReviewPanel document={planDocument} open />);
      const navigation = screen.getByRole("navigation", { name: "Plan headings" });
      const steps = await screen.findByRole("button", { name: "Steps" });
      await screen.findByRole("button", { name: "Setext heading" });

      expect(navigation.querySelectorAll("button")).toHaveLength(3);
      expect(screen.queryByRole("button", { name: "Code-only heading" })).toBeNull();
      expect(screen.getByRole("link", { name: "Steps" }).getAttribute("href")).toBe(
        "https://safe.example/steps",
      );
      expect(screen.getByRole("link", { name: "guide" }).getAttribute("href")).toBe(
        "https://guide.example",
      );
      expect(document.querySelector("img")).toBeNull();
      expect(screen.getByText("Inline raw HTML:")).toBeTruthy();

      fireEvent.click(steps);
      await waitFor(() => {
        const anchor = screen.getByRole("region", { name: "Heading: Steps" });
        expect(anchor.id).toMatch(/^plan-review-/);
        expect(anchor.tabIndex).toBe(-1);
        expect(document.activeElement).toBe(anchor);
        expect(anchor.querySelector("h2")?.textContent).toContain("Steps");
      });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    } finally {
      if (previous) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previous);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  test("announces successful copy and describes a failed copy without exposing its error", async () => {
    const onCopy = vi.fn();
    const { unmount } = render(<PlanReviewPanel document={planDocument} open onCopy={onCopy} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy plan" }));
    const copied = await screen.findByText("Plan copied.");
    expect(copied.getAttribute("role")).toBe("status");
    expect(onCopy).toHaveBeenCalledWith(planDocument.markdown);

    unmount();
    render(
      <PlanReviewPanel
        document={planDocument}
        open
        onCopy={vi.fn().mockRejectedValue(new Error("/private/path"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy plan" }));
    const copyFailure = await screen.findByText("Copy failed. Try again.");
    expect(copyFailure.getAttribute("role")).toBe("alert");
    expect(screen.queryByText("/private/path")).toBeNull();
  });

  test("announces successful export and describes a failed export without exposing its error", async () => {
    const onExport = vi.fn();
    const { unmount } = render(
      <PlanReviewPanel document={planDocument} open onExport={onExport} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export plan" }));
    const exported = await screen.findByText("Plan exported.");
    expect(exported.getAttribute("role")).toBe("status");
    expect(onExport).toHaveBeenCalledWith("markdown");

    unmount();
    render(
      <PlanReviewPanel
        document={planDocument}
        open
        onExport={vi.fn().mockRejectedValue(new Error("/private/path"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export plan" }));
    const exportFailure = await screen.findByText("Export failed. Try again.");
    expect(exportFailure.getAttribute("role")).toBe("alert");
    expect(screen.queryByText("/private/path")).toBeNull();
  });

  test("shows every heading when A1 has no section metadata", () => {
    render(<PlanReviewPanel document={{ ...planDocument, sections: [] }} open />);
    const navigation = screen.getByRole("navigation", { name: "Plan headings" });

    expect(navigation.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Setext heading" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Heading: Plan" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Heading: Steps" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Heading: Setext heading" })).toBeTruthy();
  });

  test("shows every heading when one A1 section covers the whole document", () => {
    render(
      <PlanReviewPanel
        document={{
          ...planDocument,
          sections: [{ id: "whole-plan", heading: "Plan", start: 0, end: 100 }],
        }}
        open
      />,
    );

    expect(
      screen.getByRole("navigation", { name: "Plan headings" }).querySelectorAll("button"),
    ).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Heading: Steps" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Heading: Setext heading" })).toBeTruthy();
  });

  test("hides the table of contents when a document has no headings", () => {
    render(
      <PlanReviewPanel
        document={{ ...planDocument, markdown: "Plain text only.", sections: [] }}
        open
      />,
    );
    expect(screen.queryByRole("navigation", { name: "Plan headings" })).toBeNull();
    expect(screen.getByText("Plain text only.")).toBeTruthy();
  });

  test("a new revision of the plan clears the message about Copy on the old one", async () => {
    const { rerender } = render(<PlanReviewPanel document={planDocument} open onCopy={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy plan" }));
    await screen.findByText("Plan copied.");

    rerender(<PlanReviewPanel document={{ ...planDocument, revision: 2 }} open onCopy={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("Plan copied.")).toBeNull());
  });

  test("renders the empty lifecycle without inventing a document", () => {
    render(<PlanReviewPanel document={null} open />);
    expect(screen.getByRole("status").textContent).toContain("Nothing here yet");
    expect(screen.queryByRole("navigation", { name: "Plan headings" })).toBeNull();
  });
});
