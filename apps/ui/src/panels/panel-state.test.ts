import { describe, expect, test } from "vitest";

describe("the side panel", () => {
  test("the desktop window's page event opens the panel it names, as a click on an agent's request notification does", async () => {
    // The unit tests run without a page: a window that only takes events, and a storage.
    const page = new EventTarget();
    const kept = new Map<string, string>();
    Object.assign(globalThis, {
      window: page,
      localStorage: {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
      },
    });
    const { SHOW_PANEL_EVENT } = await import("./panel-state");
    const shown = () => JSON.parse(kept.get("omp-app.ui.panel") ?? "null");

    page.dispatchEvent(new CustomEvent(SHOW_PANEL_EVENT, { detail: "access" }));
    expect(shown()).toEqual({ open: true, panel: "access" });
    // Anything but a panel's name is ignored.
    page.dispatchEvent(new CustomEvent(SHOW_PANEL_EVENT, { detail: { panel: "usage" } }));
    expect(shown()).toEqual({ open: true, panel: "access" });
  });
});
