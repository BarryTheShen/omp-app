import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppShell, type RightSidebar, useRightSidebar } from "./index";
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
    const transcript = screen.getByRole("region", { name: "Conversation transcript" });
    // Not a live region: streamed tokens must not be announced one by one.
    expect(transcript.getAttribute("aria-live")).toBeNull();
    expect(transcript.getAttribute("role")).toBeNull();
    expect(screen.getByRole("region", { name: "Composer" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Panels" })).toBeTruthy();
    expect(screen.getByRole("contentinfo", { name: "Status" })).toBeTruthy();

    const landmarks = [
      screen.getByRole("navigation", { name: "Sessions" }),
      screen.getByRole("main", { name: "Conversation" }),
      transcript,
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

describe("right sidebar requests", () => {
  test("a panel can show the right sidebar it is in after the sidebar was collapsed", () => {
    const seen: { current: RightSidebar | null } = { current: null };
    function Panel() {
      seen.current = useRightSidebar();
      return <p>Panel body</p>;
    }
    render(<AppShell rightSidebar={<Panel />} />);
    const panels = screen.getByRole("complementary", { name: "Panels" });
    fireEvent.click(screen.getByRole("button", { name: "Hide panels sidebar" }));
    expect(panels.getAttribute("data-open")).toBe("false");
    expect(seen.current?.open).toBe(false);
    act(() => {
      seen.current?.show();
    });
    expect(panels.getAttribute("data-open")).toBe("true");
    expect(seen.current?.open).toBe(true);
  });

  test("outside a shell there is no right sidebar to show", () => {
    const seen: { current: RightSidebar | null | undefined } = { current: undefined };
    function Probe() {
      seen.current = useRightSidebar();
      return null;
    }
    render(<Probe />);
    expect(seen.current).toBeNull();
  });
});

describe("sidebar controls", () => {
  test("collapse and expand both sidebars from keyboard shortcuts", () => {
    render(<AppShell />);
    const sessions = screen.getByRole("navigation", { name: "Sessions" });
    const panels = screen.getByRole("complementary", { name: "Panels" });

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sessions.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Show sessions sidebar" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(panels.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("button", { name: "Show panels sidebar" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(sessions.hasAttribute("inert")).toBe(false);
    expect(panels.hasAttribute("inert")).toBe(false);
  });

  test("an open side panel has one control that closes it, and a closed one has one control that opens it", () => {
    render(<AppShell />);
    const closers = (label: string) =>
      screen.queryAllByRole("button", { name: new RegExp(`^(Hide|Collapse) ${label} sidebar$`) });
    const openers = (label: string) =>
      screen.queryAllByRole("button", { name: `Show ${label} sidebar` });

    expect(closers("sessions")).toHaveLength(1);
    expect(openers("sessions")).toHaveLength(0);
    expect(closers("panels")).toHaveLength(1);
    expect(openers("panels")).toHaveLength(0);

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(closers("sessions")).toHaveLength(0);
    expect(openers("sessions")).toHaveLength(1);

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(closers("panels")).toHaveLength(0);
    expect(openers("panels")).toHaveLength(1);
  });

  test("the Panels sidebar keeps its own column when the sessions sidebar is hidden", () => {
    render(<AppShell />);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByRole("complementary", { name: "Panels" }).style.gridColumn).toBe("3");
  });

  test("does not hijack the typing shortcut inside an editable control", () => {
    render(<AppShell threadHeader={<input aria-label="Draft title" />} />);
    const sessions = screen.getByRole("navigation", { name: "Sessions" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft title" }), {
      key: "b",
      ctrlKey: true,
    });
    expect(sessions.hasAttribute("inert")).toBe(false);
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
    expect(document.getElementById("shell-sessions-sidebar")?.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("shell-panels-sidebar")?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector('[data-shell-drawer-backdrop="true"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show sessions sidebar" }));
    const backdrop = document.querySelector('[data-shell-drawer-backdrop="true"]');
    expect(backdrop).toBeTruthy();
    expect(document.getElementById("shell-sessions-sidebar")?.hasAttribute("inert")).toBe(false);
    fireEvent.click(backdrop as HTMLElement);
    expect(document.getElementById("shell-sessions-sidebar")?.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show panels sidebar" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.getElementById("shell-panels-sidebar")?.hasAttribute("inert")).toBe(true);
  });

  test("widening again brings back both sidebars the wide layout had open", () => {
    let narrow = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        get matches() {
          return narrow && query === "(max-width: 48rem)";
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const setNarrow = (value: boolean) => {
      narrow = value;
      act(() => {
        for (const listener of listeners) listener();
      });
    };
    const closed = (id: string) => document.getElementById(id)?.hasAttribute("inert");

    render(<AppShell />);
    expect(closed("shell-sessions-sidebar")).toBe(false);
    expect(closed("shell-panels-sidebar")).toBe(false);

    setNarrow(true);
    expect(closed("shell-sessions-sidebar")).toBe(true);
    expect(closed("shell-panels-sidebar")).toBe(true);

    setNarrow(false);
    expect(closed("shell-sessions-sidebar")).toBe(false);
    expect(closed("shell-panels-sidebar")).toBe(false);
  });
});
