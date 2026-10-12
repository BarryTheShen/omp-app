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

/** The todo panel plus an on-demand history panel, open or closed, optionally revealed again. */
function panelsWith(open: boolean, reveal?: number): SurfaceMap {
  return {
    ...surfaces,
    rewind: {
      title: "History",
      open,
      ...(reveal === undefined ? {} : { reveal }),
      render: () => <p>History body</p>,
    },
  };
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

  test("a surface whose capability is on its fallback path is shown, as the registry shows it", () => {
    const layout = layoutWith({ statusBar: ["context"] });
    const capabilities: CapabilityMap = {
      "omp.cmd.get_session_stats": { state: "fallback", via: "rpc", detail: "Totals only" },
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

  test("the arrow keys move focus and selection along the tabs; Home and End go to the ends", () => {
    render(
      <LayoutArea
        area="panels"
        layout={layoutWith({ panels: ["todo", "queue", "model"] })}
        surfaces={surfaces}
      />,
    );
    const todo = screen.getByRole("tab", { name: "Todo checklist" });
    const queue = screen.getByRole("tab", { name: "Queued messages" });
    const model = screen.getByRole("tab", { name: "Model" });
    todo.focus();
    fireEvent.keyDown(todo, { key: "ArrowRight" });
    expect(document.activeElement).toBe(queue);
    expect(queue.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Queue body")).toBeTruthy();
    fireEvent.keyDown(queue, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(todo);
    expect(screen.getByText("Todo body")).toBeTruthy();
    fireEvent.keyDown(todo, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(model);
    fireEvent.keyDown(model, { key: "ArrowRight" });
    expect(document.activeElement).toBe(todo);
    fireEvent.keyDown(todo, { key: "End" });
    expect(document.activeElement).toBe(model);
    fireEvent.keyDown(model, { key: "Home" });
    expect(document.activeElement).toBe(todo);
  });

  test("Alt, Ctrl, Meta and Shift combinations are left to the browser: the tabs do not move", () => {
    render(
      <LayoutArea
        area="panels"
        layout={layoutWith({ panels: ["todo", "queue", "model"] })}
        surfaces={surfaces}
      />,
    );
    const todo = screen.getByRole("tab", { name: "Todo checklist" });
    todo.focus();
    // fireEvent.keyDown returns false when a handler prevented the default, so these must stay true.
    expect(fireEvent.keyDown(todo, { key: "ArrowRight", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(todo, { key: "ArrowLeft", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(todo, { key: "End", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(todo, { key: "Home", metaKey: true })).toBe(true);
    expect(document.activeElement).toBe(todo);
    expect(todo.getAttribute("aria-selected")).toBe("true");
    // A plain arrow still moves along the tabs.
    expect(fireEvent.keyDown(todo, { key: "ArrowRight" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Queued messages" }));
  });

  test("only the selected tab is in the Tab order; each tab is linked to the tabpanel", () => {
    render(
      <LayoutArea
        area="panels"
        layout={layoutWith({ panels: ["todo", "queue"] })}
        surfaces={surfaces}
      />,
    );
    const todo = screen.getByRole("tab", { name: "Todo checklist" });
    const queue = screen.getByRole("tab", { name: "Queued messages" });
    const panel = screen.getByRole("tabpanel", { name: "Todo checklist" });
    expect(todo.getAttribute("tabindex")).toBe("0");
    expect(queue.getAttribute("tabindex")).toBe("-1");
    expect(todo.getAttribute("aria-controls")).toBe(panel.id);
    expect(queue.getAttribute("aria-controls")).toBe(panel.id);
    fireEvent.click(queue);
    expect(queue.getAttribute("tabindex")).toBe("0");
    expect(todo.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tabpanel", { name: "Queued messages" })).toBe(panel);
  });

  test("lists an on-demand panel only while it is open", () => {
    const layout = layoutWith({ panels: ["todo", "rewind"] });
    expect(areaSurfaces("panels", panelsWith(false), {}, layout).map(([id]) => id)).toEqual([
      "todo",
    ]);
    expect(areaSurfaces("panels", panelsWith(true), {}, layout).map(([id]) => id)).toEqual([
      "todo",
      "rewind",
    ]);
  });

  test("a panel that opens becomes the tab shown, and a reveal brings it forward again", () => {
    const layout = layoutWith({ panels: ["todo", "rewind"] });
    const { rerender } = render(
      <LayoutArea area="panels" layout={layout} surfaces={panelsWith(false)} />,
    );
    expect(screen.getByText("Todo body")).toBeTruthy();
    rerender(<LayoutArea area="panels" layout={layout} surfaces={panelsWith(true, 1)} />);
    expect(screen.getByText("History body")).toBeTruthy();
    expect(screen.queryByText("Todo body")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Todo checklist" }));
    expect(screen.getByText("Todo body")).toBeTruthy();
    rerender(<LayoutArea area="panels" layout={layout} surfaces={panelsWith(true, 1)} />);
    expect(screen.getByText("Todo body")).toBeTruthy();
    rerender(<LayoutArea area="panels" layout={layout} surfaces={panelsWith(true, 2)} />);
    expect(screen.getByText("History body")).toBeTruthy();
  });

  test("a full-row surface starts a line of its own in a wrapping row", () => {
    const rowSurfaces: SurfaceMap = {
      ...surfaces,
      queue: { title: "Queued messages", fullRow: true, render: () => <p>Queue body</p> },
    };
    const { container } = render(
      <LayoutArea
        area="composerToolbar"
        layout={layoutWith({ composerToolbar: ["model", "queue"] })}
        surfaces={rowSurfaces}
      />,
    );
    const queueClass = container.querySelector('[data-surface="queue"]')?.className ?? "";
    const modelClass = container.querySelector('[data-surface="model"]')?.className ?? "";
    expect(queueClass).toContain("basis-full");
    expect(modelClass).not.toContain("basis-full");
  });
});
