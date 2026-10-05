import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CustomMessageRow,
  FileMentionRow,
  ProviderErrorRow,
  RetryRecoveryRow,
  SessionEntryRow,
  TerminalErrorRow,
  ToolResultAttachmentRow,
} from "../../rows";

afterEach(cleanup);

describe("U1.6 transcript rows", () => {
  test("renders display=true custom messages and suppresses display=false continuity rows", () => {
    const { container } = render(
      <>
        <CustomMessageRow content="Extension body" customType="notice" detail="safe fallback" />
        <CustomMessageRow content="Hidden continuity" customType="continuity" display={false} />
      </>,
    );

    expect(screen.getByText("Extension message")).toBeTruthy();
    expect(screen.getByText("safe fallback")).toBeTruthy();
    expect(screen.queryByText("Hidden continuity")).toBeNull();
    expect(container.querySelectorAll('[data-u1-row-kind="custom-message"]')).toHaveLength(1);
  });

  test("renders file and claimed session-entry row kinds", () => {
    render(
      <>
        <FileMentionRow
          files={[
            { path: "src/main.ts", lineCount: 12 },
            { path: "assets/logo.png", image: true },
            { path: "archive.zip", skippedReason: "binary file" },
          ]}
        />
        <SessionEntryRow detail="model-x → model-y" kind="model-change" />
        <SessionEntryRow detail="Summarized 12000 tokens" kind="compaction-summary" />
        <SessionEntryRow detail="Parent branch" kind="branch-summary" />
      </>,
    );

    expect(screen.getByText("src/main.ts")).toBeTruthy();
    expect(screen.getByText("12 lines")).toBeTruthy();
    expect(screen.getByText("binary file")).toBeTruthy();
    expect(screen.getByText("Model changed: model-x → model-y")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compaction summary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Branch summary" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compaction summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Branch summary" }));
    expect(screen.getByText("Summarized 12000 tokens")).toBeTruthy();
    expect(screen.getByText("Parent branch")).toBeTruthy();
  });

  test("expands bounded provider details and exposes terminal retry", () => {
    const onRetry = vi.fn();
    render(
      <>
        <ProviderErrorRow
          details="provider detail line"
          message="Provider unavailable"
          provider="test-provider"
          status={503}
        />
        <TerminalErrorRow message="The runtime stopped" onRetry={onRetry} retryable />
      </>,
    );

    expect(screen.getByText("Provider unavailable")).toBeTruthy();
    expect(screen.queryByText("provider detail line")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("provider detail line")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("renders retry countdown, recovered and failed states", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <RetryRecoveryRow
        attempt={2}
        delaySeconds={5}
        providerError="rate limited"
        state="retrying"
        total={3}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Retrying in 5s (2/3)");
    expect(screen.getByText("rate limited")).toBeTruthy();

    rerender(<RetryRecoveryRow attempt={2} state="recovered" total={3} />);
    expect(screen.getByRole("status").textContent).toContain("Recovered after retry");

    rerender(<RetryRecoveryRow attempt={3} onRetry={onRetry} state="failed" total={3} />);
    expect(screen.getByRole("alert").textContent).toContain("Retry failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("attaches returned images and files by tool call id", () => {
    const { container } = render(
      <ToolResultAttachmentRow
        files={[{ detail: "text/plain", name: "result.txt" }]}
        images={[{ alt: "Chart", src: "data:image/png;base64,ZmFrZQ==" }]}
        toolCallId="call-chart"
      />,
    );

    expect(container.querySelector('[data-tool-call-id="call-chart"]')).toBeTruthy();
    expect(screen.getByAltText("Chart")).toBeTruthy();
    expect(screen.getByText("result.txt")).toBeTruthy();
  });
});
