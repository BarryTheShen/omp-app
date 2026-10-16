import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolAvailability } from "../contract";
import { ToolAvailabilitySurface } from "./index";

afterEach(() => cleanup());

const tools: readonly ToolAvailability[] = [
  { tool: "browser", state: "available", mode: "browser", capability: "host.command-gateway" },
  {
    tool: "computer",
    state: "fallback",
    mode: "computer",
    capability: "host.command-gateway",
    reason: "The app can only partly provide this tool.",
  },
  { tool: "vision", state: "unknown", mode: "vision" },
];

describe("D7.4 tools and skills", () => {
  test("renders D7.1 states and reasons, and forwards skill commands", () => {
    const onSkillful = vi.fn();
    render(
      <ToolAvailabilitySurface
        canRun
        onList={vi.fn()}
        onRetry={vi.fn()}
        onSkillful={onSkillful}
        surface={{ state: "idle" }}
        tools={tools}
      />,
    );

    const list = screen.getByRole("list", { name: "Tool availability" });
    expect(list.textContent).toContain("browser");
    expect(list.textContent).toContain("Available");
    expect(list.textContent).toContain("computer");
    expect(list.textContent).toContain(
      "Limited · Computer use · The app can only partly provide this tool.",
    );
    expect(list.textContent).toContain("Not confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Hide skills in prompts" }));
    expect(onSkillful).toHaveBeenCalledWith("/skillful off");
  });

  test("disables commands with a visible reason when the command gateway is unavailable", () => {
    render(
      <ToolAvailabilitySurface
        canRun={false}
        onList={vi.fn()}
        onRetry={vi.fn()}
        onSkillful={vi.fn()}
        surface={{ state: "unavailable", message: "Commands are not available in this chat." }}
        tools={tools}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Refresh available tools" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("Commands are not available in this chat.")).toBeTruthy();
  });
});
