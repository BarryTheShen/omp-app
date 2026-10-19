import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { BrowserToolCard } from "./browser";
import {
  BROWSER_ERROR_RESULT,
  BROWSER_MANY_SCREENSHOTS_RESULT,
  BROWSER_RESULT,
} from "./fixtures/v18.9.1-results";

afterEach(() => cleanup());

function props(result: unknown, extra: Record<string, unknown> = {}): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "browser-1",
    toolName: "browser",
    args: { action: "run", name: "docs", code: "return document.title" },
    argsText: '{"action":"run","name":"docs"}',
    result,
    status: { type: "complete" },
    ...extra,
  } as unknown as ToolRendererProps;
}

describe("BrowserToolCard", () => {
  test("reads value and screenshot metadata from result.details", () => {
    render(<BrowserToolCard {...props(BROWSER_RESULT)} />);
    expandToolCards();

    expect(screen.getByText("Run · docs · https://bun.sh/docs")).toBeTruthy();
    expect(screen.getAllByText("Get started with Bun")).toHaveLength(2);
    expect(screen.getByText("Returned value")).toBeTruthy();
    expect(screen.getByTestId("t4-browser-value").textContent).toContain("Returned value");
    expect(screen.getByTestId("t4-browser-screenshots").textContent).toContain(
      "Screenshot 1: image/png, 1280 × 800, 2048 bytes",
    );
    expect(screen.getByTestId("t4-browser-screenshots").textContent).not.toContain("<TMP>");
  });

  test("caps screenshot metadata at four while reporting the remaining count", () => {
    render(<BrowserToolCard {...props(BROWSER_MANY_SCREENSHOTS_RESULT)} />);
    expandToolCards();
    const screenshots = screen.getByTestId("t4-browser-screenshots");
    const shown = [...screenshots.querySelectorAll("li")].filter((item) =>
      item.textContent?.startsWith("Screenshot "),
    );
    expect(shown).toHaveLength(4);
    expect(screenshots.textContent).toContain("Showing 4 of 5 screenshots");
  });

  test("preserves a browser error from the result envelope", () => {
    render(<BrowserToolCard {...props(BROWSER_ERROR_RESULT, { isError: true })} />);
    expandToolCards();
    expect(screen.getByRole("button", { name: "browser: Error" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Browser permission denied");
  });
});
