import { FolderPath } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DraftNotice } from "./draft-notice";
import type { DraftSnapshot } from "./drafts";

afterEach(cleanup);

const scope = { kind: "folder", folder: FolderPath.parse("/workspace/app") } as const;

function snapshot(overrides: Partial<DraftSnapshot>): DraftSnapshot {
  return {
    scope,
    status: "ready",
    text: "typed",
    attachments: [],
    failedSends: [],
    revision: null,
    dirty: true,
    conflict: null,
    error: null,
    replaced: null,
    localCopyRefused: false,
    ...overrides,
  };
}

function renderNotice(draft: DraftSnapshot): void {
  render(
    <DraftNotice
      snapshot={draft}
      onRetry={vi.fn()}
      onResolve={vi.fn(async () => undefined)}
      onResolveReplaced={vi.fn()}
    />,
  );
}

describe("the draft status line when this browser keeps no copy", () => {
  test("says in plain words that the browser could not keep a copy and that the draft is still saved to the app", () => {
    renderNotice(snapshot({ localCopyRefused: true }));

    expect(screen.getByRole("status").textContent).toContain(
      "This browser could not keep a copy of your draft. It is still saved to the app.",
    );
  });

  test("shows nothing once the browser keeps its copy again", () => {
    renderNotice(snapshot({ localCopyRefused: false }));

    expect(screen.queryByRole("status")).toBeNull();
  });
});
