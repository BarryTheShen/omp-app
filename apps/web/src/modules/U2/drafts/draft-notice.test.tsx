import {
  AppFailure,
  type Draft,
  type DraftScope,
  FolderPath,
  type Revision,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DraftNotice } from "./draft-notice";
import type { DraftSnapshot } from "./drafts";

afterEach(cleanup);

const scope: DraftScope = { kind: "folder", folder: FolderPath.parse("/workspace/app") };

function snapshot(overrides: Partial<DraftSnapshot>): DraftSnapshot {
  return {
    scope,
    status: "ready",
    text: "",
    attachments: [],
    failedSends: [],
    revision: null,
    dirty: false,
    conflict: null,
    error: null,
    ...overrides,
  };
}

function remoteDraft(text: string): Draft {
  return {
    scope,
    text,
    attachments: [],
    failedSends: [],
    revision: "r2" as Revision,
    updatedAt: new Date(2).toISOString(),
  };
}

function conflictOver(remote: Draft | null): DraftSnapshot {
  return snapshot({
    status: "conflict",
    text: "this tab's text",
    dirty: true,
    conflict: {
      local: { text: "this tab's text", attachments: [], failedSends: [] },
      remote,
    },
    error: new AppFailure({
      code: "conflict",
      message: "The draft changed in another tab",
      retryable: true,
    }),
  });
}

describe("DraftNotice", () => {
  test("a conflict says the other tab changed the draft, shows the start of its text, and offers both choices", () => {
    const onResolve = vi.fn(async () => undefined);
    render(
      <DraftNotice
        snapshot={conflictOver(remoteDraft("first line\n\nsecond   line"))}
        onRetry={vi.fn()}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("The other tab changed this draft.");
    expect(screen.getByText("first line second line")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep this tab's text" }));
    expect(onResolve).toHaveBeenLastCalledWith("local");
    fireEvent.click(screen.getByRole("button", { name: "Use the other tab's text" }));
    expect(onResolve).toHaveBeenLastCalledWith("remote");
  });

  test("a long text from the other tab is cut to one line of about 80 characters", () => {
    const long = Array.from({ length: 60 }, () => "word").join(" ");
    render(
      <DraftNotice
        snapshot={conflictOver(remoteDraft(long))}
        onRetry={vi.fn()}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    const preview = screen.getByTitle(long);
    expect(preview.textContent?.length).toBeLessThanOrEqual(80);
    expect(preview.textContent?.endsWith("…")).toBe(true);
    expect(preview.textContent?.startsWith("word word")).toBe(true);
  });

  test("a draft the other tab cleared says so, and still offers both choices", () => {
    render(
      <DraftNotice
        snapshot={conflictOver(null)}
        onRetry={vi.fn()}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("The other tab cleared this draft.");
    expect(screen.getByRole("button", { name: "Keep this tab's text" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the other tab's text" })).toBeTruthy();
  });

  test("a failed draft shows its reason, and Retry runs the step that failed again", () => {
    const onRetry = vi.fn();
    render(
      <DraftNotice
        snapshot={snapshot({
          status: "error",
          error: new AppFailure({
            code: "unavailable",
            message: "Moving the draft failed",
            retryable: true,
          }),
        })}
        onRetry={onRetry}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("Moving the draft failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("a draft that is fine shows nothing", () => {
    const { container } = render(
      <DraftNotice
        snapshot={snapshot({ status: "ready" })}
        onRetry={vi.fn()}
        onResolve={vi.fn(async () => undefined)}
      />,
    );

    expect(container.textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
