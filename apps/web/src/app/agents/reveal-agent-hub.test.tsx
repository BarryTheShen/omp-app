import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AppShell } from "@/shell";
import { RevealAgentHub } from "./agents-tab";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function shell(reveal: number) {
  return <AppShell rightSidebar={<RevealAgentHub reveal={reveal} />} />;
}

/** The Panels sidebar. A closed one is hidden from assistive technology, so it is found by its attribute, not its name. */
function panelsSidebar(): HTMLElement {
  const sidebar = document.querySelector<HTMLElement>('[data-shell-sidebar="right"]');
  if (sidebar === null) throw new Error("The Panels sidebar is not rendered.");
  return sidebar;
}

describe("the Agent Hub reveal", () => {
  test("a new reveal opens a collapsed Panels sidebar; the same reveal again leaves it closed", () => {
    const { rerender } = render(shell(0));
    // A first visit starts with the panel closed.
    const panels = panelsSidebar();
    expect(panels.getAttribute("data-open")).toBe("false");

    rerender(shell(1));
    expect(panels.getAttribute("data-open")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hide panels sidebar" }));
    rerender(shell(1));
    expect(panels.getAttribute("data-open")).toBe("false");
  });
});
