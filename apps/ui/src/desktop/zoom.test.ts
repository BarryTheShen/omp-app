import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keptZoom, stepZoom, ZOOM_LEVELS } from "./zoom";

function storage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  };
}

describe("the desktop window's zoom", () => {
  beforeEach(() => vi.stubGlobal("localStorage", storage()));
  afterEach(() => vi.unstubAllGlobals());

  test("Ctrl + and Ctrl − step through a browser's levels, and stay at either end", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.9, -1)).toBe(0.8);
    expect(stepZoom(ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 3, 1)).toBe(3);
    expect(stepZoom(ZOOM_LEVELS[0] ?? 0.5, -1)).toBe(0.5);
  });

  test("the kept level comes back at start; none, or one these levels do not have, is 100%", () => {
    expect(keptZoom()).toBe(1);
    localStorage.setItem("omp-app.ui.zoom", "1.25");
    expect(keptZoom()).toBe(1.25);
    localStorage.setItem("omp-app.ui.zoom", "1.3");
    expect(keptZoom()).toBe(1);
  });
});
