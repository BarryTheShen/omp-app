import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelCatalogPort, ModelCatalogSnapshot } from "@/modules/D1/contract";
import { ExecutionTierSlider } from "./view";

afterEach(cleanup);

function catalog(
  efforts: readonly ("low" | "medium" | "high")[] = ["low", "medium", "high"],
): ModelCatalogPort {
  const snapshot: ModelCatalogSnapshot = {
    loadState: "ready",
    models: [
      {
        provider: "fake",
        id: "reasoning",
        name: "Reasoning",
        api: "chat-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        thinkingEfforts: [...efforts],
        availability: "available",
      },
    ],
    current: { provider: "fake", modelId: "reasoning" },
    capabilities: {},
    error: null,
  };
  return { getSnapshot: () => snapshot, refresh: vi.fn(), apply: vi.fn(), subscribe: vi.fn() };
}

describe("ExecutionTierSlider", () => {
  test("follows value, exposes value text, and calls only onChange", () => {
    const catalogValue = catalog();
    const onChange = vi.fn();
    const { rerender } = render(
      <ExecutionTierSlider catalog={catalogValue} value="low" onChange={onChange} />,
    );
    const slider = screen.getByRole("slider", { name: "Execution tier" });
    expect(slider.getAttribute("value")).toBe("0");
    expect(slider.getAttribute("aria-valuetext")).toBe("Low");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("medium");
    expect(catalogValue.apply).not.toHaveBeenCalled();
    rerender(<ExecutionTierSlider catalog={catalogValue} value="high" onChange={onChange} />);
    expect(screen.getByRole("slider", { name: "Execution tier" }).getAttribute("value")).toBe("2");
    expect(
      screen.getByRole("slider", { name: "Execution tier" }).getAttribute("aria-valuetext"),
    ).toBe("High");
  });
  test("one effort option renders no slider", () => {
    const { container } = render(
      <ExecutionTierSlider catalog={catalog(["high"])} value="high" onChange={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });
  test("no effort options render no slider", () => {
    const { container } = render(
      <ExecutionTierSlider catalog={catalog([])} value="high" onChange={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });

  test("unsupported value is disabled, labeled unavailable, and announced", () => {
    render(
      <ExecutionTierSlider
        catalog={catalog()}
        value="xhigh"
        onChange={vi.fn()}
        error="Could not save."
      />,
    );
    expect(screen.getByText("This model does not offer that level.")).toBeTruthy();
    expect(screen.getAllByRole("alert")[1]?.textContent).toContain("Could not save.");
    const slider = screen.getByRole("slider", { name: "Execution tier" });
    expect(slider.hasAttribute("disabled")).toBe(true);
    expect(slider.getAttribute("aria-valuetext")).toBe("Unavailable");
  });
});
