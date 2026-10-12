import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { BrowserToolCard } from "./browser";

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
  test("renders action/tab, highlighted JavaScript, observations and screenshots", async () => {
    render(
      <BrowserToolCard
        {...props({
          kind: "browser",
          action: "run",
          name: "docs",
          url: "https://example.test/docs",
          observations: [{ text: "Page title" }],
          screenshots: [{ data: "data:image/png;base64,AAAA" }],
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("t4-browser-card")).toBeTruthy();
    expect(screen.getByText("Run · docs · https://example.test/docs")).toBeTruthy();
    expect(screen.getByText("return document.title")).toBeTruthy();
    expect(screen.getByTestId("t4-browser-observations").textContent).toContain("Page title");
    expect(screen.getByRole("img", { name: "Browser screenshot 1" })).toBeTruthy();
    screen.getByRole("button", { name: "Open browser screenshot 1" }).click();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Browser screenshot 1" })).toBeTruthy(),
    );
    screen.getByRole("button", { name: "Close" }).click();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByText("Result")).toBeTruthy());
  });

  test("preserves a typed browser failure in the U3 error state", () => {
    render(
      <BrowserToolCard
        {...props({ kind: "browser", action: "open", error: "Browser permission denied" })}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("alert").textContent).toContain("Browser permission denied");
  });
});
