import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LimitBar } from "./limit-bar";

afterEach(() => cleanup());

const now = new Date("2026-10-10T06:00:00.000Z");
const resetIn = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

describe("LimitBar", () => {
  test("draws the used share as a progress bar named for its provider and window", () => {
    render(
      <LimitBar
        now={now}
        providerId="anthropic"
        window={{ label: "5 Hour", usedPercent: 4, resetsAt: resetIn(125), accounts: 1 }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "anthropic, 5 hour limit" });
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    expect(bar.getAttribute("aria-valuetext")).toBe("4% used, resets in 2 h 5 min");
    expect(bar.getAttribute("data-tone")).toBe("normal");
    expect(screen.getByText("4% used")).toBeTruthy();
    expect(screen.getByText(/resets in 2 h 5 min/)).toBeTruthy();
  });

  test("the bar turns danger at 90%, and a window of several accounts says so plainly", () => {
    render(
      <LimitBar
        now={now}
        providerId="openai-codex"
        window={{ label: "7 days", usedPercent: 92, resetsAt: resetIn(30), accounts: 2 }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "openai-codex, 7 days limit" });
    expect(bar.getAttribute("data-tone")).toBe("danger");
    expect(screen.getByText(/the fullest of 2 accounts/)).toBeTruthy();
  });

  test("a share omp did not say reads as unknown, never as zero", () => {
    render(
      <LimitBar
        now={now}
        providerId="cursor"
        window={{ label: "Monthly", usedPercent: Number.NaN, resetsAt: null, accounts: 1 }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "cursor, monthly limit" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-valuetext")).toBe("usage unknown, reset time unknown");
    expect(screen.getByText("usage unknown")).toBeTruthy();
  });
});
