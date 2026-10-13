import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ResizeHandle } from "./resize-handle";

afterEach(cleanup);

describe("ResizeHandle", () => {
  test("the Sessions grip sits on its end edge, where that sidebar draws its border", () => {
    render(<ResizeHandle side="left" value={18} minimum={14} maximum={32} onChange={vi.fn()} />);
    const grip = screen.getByRole("separator", { name: "Resize sessions sidebar" });
    expect(grip.className).toContain("end-0");
    expect(grip.className).not.toContain("start-0");
  });

  test("the Panels grip sits on its start edge, the inner border of the sidebar on the window's right", () => {
    render(<ResizeHandle side="right" value={18} minimum={14} maximum={32} onChange={vi.fn()} />);
    const grip = screen.getByRole("separator", { name: "Resize panels sidebar" });
    expect(grip.className).toContain("start-0");
    expect(grip.className).not.toContain("end-0");
  });

  test("both grips span their sidebar's full height: the grip sets its own height to auto and drops the preflight border", () => {
    render(<ResizeHandle side="right" value={18} minimum={14} maximum={32} onChange={vi.fn()} />);
    const grip = screen.getByRole("separator", { name: "Resize panels sidebar" });
    expect(grip.className).toContain("h-auto");
    expect(grip.className).toContain("border-0");
  });
});
