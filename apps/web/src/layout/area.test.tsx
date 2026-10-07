import type { CapabilityMap } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { areaSurfaces, LayoutArea, type SurfaceMap } from "./area";
import { type AppLayout, LAYOUT } from "./layout";

afterEach(cleanup);

const surfaces: SurfaceMap = {
  title: { title: "Conversation", grow: true, render: () => <span>Title</span> },
  model: { title: "Model", render: () => <button type="button">Model</button> },
  context: {
    title: "Context",
    requires: ["omp.cmd.get_session_stats"],
    render: () => <span>Context</span>,
  },
  todo: { title: "Todo checklist", render: () => <p>Todo body</p> },
  scrollFollow: {
    title: "Transcript actions",
    render: () => <button type="button">Jump to latest</button>,
  },
  queue: { title: "Queued messages", render: () => <p>Queue body</p> },
};

function layoutWith(patch: Partial<AppLayout>): AppLayout {
  return { ...LAYOUT, ...patch };
}

describe("LayoutArea", () => {
  test("places transcript controls in the transcript footer", () => {
    expect(areaSurfaces("threadFooter", surfaces).map(([id]) => id)).toEqual(["scrollFollow"]);
  });
  test("renders an area's surfaces in layout order; moving an id moves the control", () => {
    const { container, rerender } = render(
      <LayoutArea
        area="header"
        layout={layoutWith({ header: ["title", "model"] })}
        surfaces={surfaces}
      />,
    );
    const ids = () =>
      [...container.querySelectorAll("[data-surface]")].map((node) =>
        node.getAttribute("data-surface"),
      );
    expect(ids()).toEqual(["title", "model"]);
    rerender(
      <LayoutArea
        area="header"
        layout={layoutWith({ header: ["model", "title"] })}
        surfaces={surfaces}
      />,
    );
    expect(ids()).toEqual(["model", "title"]);
    // Moved to the status bar: gone from the header.
    rerender(
      <LayoutArea
        area="header"
        layout={layoutWith({ header: ["title"], statusBar: ["model"] })}
        surfaces={surfaces}
      />,
    );
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
  });

  test("leaves out surfaces whose capabilities are missing and ids with no surface", () => {
    const layout = layoutWith({ statusBar: ["context", "mode"] });
    expect(areaSurfaces("statusBar", surfaces, {}, layout)).toEqual([]);
    const capabilities: CapabilityMap = {
      "omp.cmd.get_session_stats": { state: "available", via: "rpc" },
    };
    expect(areaSurfaces("statusBar", surfaces, capabilities, layout).map(([id]) => id)).toEqual([
      "context",
    ]);
  });

  test("turns several panels into tabs", () => {
    render(
      <LayoutArea
        area="panels"
        layout={layoutWith({ panels: ["todo", "queue"] })}
        surfaces={surfaces}
      />,
    );
    expect(screen.getByText("Todo body")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Queued messages" }));
    expect(screen.getByText("Queue body")).toBeTruthy();
    expect(screen.queryByText("Todo body")).toBeNull();
  });
});
