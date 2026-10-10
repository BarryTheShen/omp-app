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

describe("the Agent Hub reveal", () => {
  test("a new reveal opens a collapsed Panels sidebar; the same reveal again leaves it closed", () => {
    const { rerender } = render(shell(0));
    const panels = screen.getByRole("complementary", { name: "Panels" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse panels sidebar" }));
    expect(panels.getAttribute("data-open")).toBe("false");

    rerender(shell(1));
    expect(panels.getAttribute("data-open")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse panels sidebar" }));
    rerender(shell(1));
    expect(panels.getAttribute("data-open")).toBe("false");
  });
});
