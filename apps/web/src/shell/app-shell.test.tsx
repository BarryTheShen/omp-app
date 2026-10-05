import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppShell } from "./index";
import { SHELL_PREFERENCES_STORAGE_KEY } from "./preferences";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppShell regions", () => {
  test("renders named regions in visual and focus order", () => {
    render(<AppShell />);

    expect(screen.getByRole("navigation", { name: "Sessions" })).toBeTruthy();
    expect(screen.getByRole("main", { name: "Conversation" })).toBeTruthy();
    expect(screen.getByRole("log", { name: "Conversation transcript" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Composer" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Panels" })).toBeTruthy();
    expect(screen.getByRole("contentinfo", { name: "Status" })).toBeTruthy();

    const landmarks = [
      screen.getByRole("navigation", { name: "Sessions" }),
      screen.getByRole("main", { name: "Conversation" }),
      screen.getByRole("log", { name: "Conversation transcript" }),
      screen.getByRole("region", { name: "Composer" }),
      screen.getByRole("complementary", { name: "Panels" }),
      screen.getByRole("contentinfo", { name: "Status" }),
    ].map((element) => element.getAttribute("aria-label"));
    expect(landmarks).toEqual([
      "Sessions",
      "Conversation",
      "Conversation transcript",
      "Composer",
      "Panels",
      "Status",
    ]);
  });
});

describe("sidebar controls", () => {
  test("collapse and expand both sidebars from keyboard shortcuts", () => {
    render(<AppShell />);
    const sessions = screen.getByRole("navigation", { name: "Sessions" });
    const panels = screen.getByRole("complementary", { name: "Panels" });

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sessions.hasAttribute("hidden")).toBe(true);
    expect(screen.getByRole("button", { name: "Show sessions sidebar" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(panels.hasAttribute("hidden")).toBe(true);
    expect(screen.getByRole("button", { name: "Show panels sidebar" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(sessions.hasAttribute("hidden")).toBe(false);
    expect(panels.hasAttribute("hidden")).toBe(false);
  });

  test("does not hijack the typing shortcut inside an editable control", () => {
    render(<AppShell threadHeader={<input aria-label="Draft title" />} />);
    const sessions = screen.getByRole("navigation", { name: "Sessions" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft title" }), {
      key: "b",
      ctrlKey: true,
    });
    expect(sessions.hasAttribute("hidden")).toBe(false);
  });
});

describe("sidebar widths", () => {
  test("adjusts and restores bounded widths through app-owned storage", () => {
    const first = render(<AppShell />);
    const separator = screen.getByRole("separator", { name: "Resize sessions sidebar" });
    expect(separator.getAttribute("aria-valuenow")).toBe("18");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("19");
    expect(window.localStorage.getItem(SHELL_PREFERENCES_STORAGE_KEY)).toContain(
      '"leftSidebarWidth":19',
    );
    first.unmount();

    render(<AppShell />);
    expect(
      screen
        .getByRole("separator", { name: "Resize sessions sidebar" })
        .getAttribute("aria-valuenow"),
    ).toBe("19");
  });

  test("clamps keyboard resizing at its minimum and maximum", () => {
    render(<AppShell />);
    const separator = screen.getByRole("separator", { name: "Resize sessions sidebar" });

    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("14");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("32");
  });
  test("shows a recoverable status when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    render(<AppShell />);
    expect(screen.getByRole("status").textContent).toContain("could not be saved");
  });
});

describe("narrow layout", () => {
  test("uses drawer mode below the breakpoint and removes resize handles", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 48rem)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    render(<AppShell />);
    expect(document.querySelector('[data-shell-layout="narrow"]')).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize sessions sidebar" })).toBeNull();
    expect(document.getElementById("shell-sessions-sidebar")?.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById("shell-panels-sidebar")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector('[data-shell-drawer-backdrop="true"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show sessions sidebar" }));
    const backdrop = document.querySelector('[data-shell-drawer-backdrop="true"]');
    expect(backdrop).toBeTruthy();
    expect(document.getElementById("shell-sessions-sidebar")?.hasAttribute("hidden")).toBe(false);
    fireEvent.click(backdrop as HTMLElement);
    expect(document.getElementById("shell-sessions-sidebar")?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show panels sidebar" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.getElementById("shell-panels-sidebar")?.hasAttribute("hidden")).toBe(true);
  });
});
