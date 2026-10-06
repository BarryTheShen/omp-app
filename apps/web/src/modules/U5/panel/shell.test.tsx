import { AppError } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PanelState } from "./contract";
import { PanelShell } from "./shell";

const baseState: PanelState = {
  open: true,
  lifecycle: "populated",
  position: "right",
  title: "Todo panel",
  description: "Current tasks",
  error: null,
  readOnly: false,
  pendingUpdates: 0,
};

function state(patch: Partial<PanelState> = {}): PanelState {
  return { ...baseState, ...patch };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PanelShell lifecycle and accessibility", () => {
  test("renders lifecycle states, region label and recoverable error retry", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <PanelShell
        body={<p>Tasks</p>}
        state={state({ lifecycle: "loading" })}
        onOpenChange={vi.fn()}
      />,
    );
    const loadingRegion = screen.getByRole("region", { name: "Todo panel" });
    expect(loadingRegion.getAttribute("data-panel-lifecycle")).toBe("loading");
    expect(screen.getByRole("status").textContent).toContain("Loading");
    rerender(
      <PanelShell
        body={<p>Tasks</p>}
        onRetry={onRetry}
        state={state({
          lifecycle: "error",
          error: AppError.parse({ code: "timeout", message: "Retry me", retryable: true }),
        })}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Retry me");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
    rerender(
      <PanelShell
        body={<p>Tasks</p>}
        state={state({ lifecycle: "empty" })}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Nothing here yet");
  });

  test("moves focus only for an invoking open, restores once, and closes on Escape", () => {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const onOpenChange = vi.fn();
    const restoreFocus = vi.fn();
    const { rerender } = render(
      <PanelShell
        body={<button type="button">First control</button>}
        invokingFocus="open-token"
        restoreFocus={restoreFocus}
        state={state({ open: false, lifecycle: "closed" })}
        onOpenChange={onOpenChange}
      />,
    );
    rerender(
      <PanelShell
        body={<button type="button">First control</button>}
        invokingFocus="open-token"
        restoreFocus={restoreFocus}
        state={state()}
        onOpenChange={onOpenChange}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close Todo panel" }));
    const region = screen.getByRole("region", { name: "Todo panel" });
    fireEvent.keyDown(region, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false, "escape");

    rerender(
      <PanelShell
        body={<button type="button">First control</button>}
        invokingFocus="open-token"
        restoreFocus={restoreFocus}
        state={state({ open: false, lifecycle: "closed" })}
        onOpenChange={onOpenChange}
      />,
    );
    expect(restoreFocus).toHaveBeenCalledTimes(1);
    opener.remove();
  });

  test("does not steal focus on passive opens", () => {
    const outside = document.createElement("button");
    outside.type = "button";
    outside.textContent = "Outside";
    document.body.append(outside);
    outside.focus();
    const { rerender } = render(
      <PanelShell
        body={<p>Tasks</p>}
        state={state({ open: false, lifecycle: "closed" })}
        onOpenChange={vi.fn()}
      />,
    );
    rerender(<PanelShell body={<p>Tasks</p>} state={state()} onOpenChange={vi.fn()} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("PanelShell scroll and responsive behavior", () => {
  test("preserves manual scroll and offers jump to latest", () => {
    const { rerender } = render(
      <PanelShell
        body={<p data-testid="content">first</p>}
        state={state()}
        onOpenChange={vi.fn()}
      />,
    );
    const body = screen.getByTestId("content").parentElement as HTMLDivElement;
    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 80 },
    });
    fireEvent.scroll(body);
    rerender(
      <PanelShell
        body={<p data-testid="content">second</p>}
        state={state()}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Jump to latest panel updates" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest panel updates" }));
    expect(body.scrollTop).toBe(400);
  });

  test("marks a narrow panel as the U0 drawer surface", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("48rem"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    render(<PanelShell body={<p>Tasks</p>} state={state()} onOpenChange={vi.fn()} />);
    expect(
      screen.getByRole("region", { name: "Todo panel" }).getAttribute("data-panel-layout"),
    ).toBe("drawer");
  });
});
