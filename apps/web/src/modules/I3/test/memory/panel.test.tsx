import { AppFailure, FolderPath, type MemoryScope, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay";
import type { MemoryCenterController } from "../../memory/controller";
import { MemoryCenterPanel } from "../../memory/panel";

const folder = FolderPath.parse("/workspace/project");
const threadId = ThreadId.parse("memory-thread");

function controller(
  overrides: Partial<MemoryCenterController["state"]> = {},
): MemoryCenterController {
  return {
    state: {
      open: true,
      scope: "project",
      entries: [],
      selected: undefined,
      draft: "",
      draftDirty: false,
      draftConflict: false,
      loading: false,
      saving: false,
      deleting: false,
      revision: null,
      error: null,
      errorAction: null,
      command: null,
      canEdit: true,
      commandGatewayAvailable: true,
      ...overrides,
    },
    actions: {
      open: vi.fn(),
      close: vi.fn(),
      setScope: vi.fn(async (_scope: MemoryScope) => undefined),
      select: vi.fn(async () => undefined),
      setDraft: vi.fn(),
      reloadDraft: vi.fn(async () => undefined),
      keepDraft: vi.fn(),
      refresh: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => undefined),
    },
  };
}

afterEach(() => cleanup());

describe("memory control-center panel", () => {
  test("renders explicit empty and scope states", () => {
    render(
      <OverlayHost>
        <MemoryCenterPanel controller={controller()} />
      </OverlayHost>,
    );
    expect(screen.getByRole("heading", { name: "Memory" })).toBeTruthy();
    expect(screen.getByText("No memory in this scope")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Memory scope" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear memory" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset memory" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete mental model" })).toBeNull();
    expect(screen.getByRole("button", { name: "Queue consolidation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rebuild memory" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reload mental models" })).toBeTruthy();
  });

  test("shows saved content and keeps destructive actions visible but separate", () => {
    const current = controller({
      entries: [
        {
          id: "0123456789abcdef",
          scope: "project",
          folder,
          threadId,
          namespace: "project",
          content: "Keep this private.",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          sensitive: true,
        },
      ],
      selected: {
        id: "0123456789abcdef",
        scope: "project",
        folder,
        threadId,
        namespace: "project",
        content: "Keep this private.",
        metadata: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sensitive: true,
      },
      draft: "Keep this private.",
    });
    render(
      <OverlayHost>
        <MemoryCenterPanel controller={current} />
      </OverlayHost>,
    );
    expect(screen.getByText(/Private memory/)).toBeTruthy();
    expect(screen.getByRole("option", { name: /Memory item 1/ })).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Memory content" }) as HTMLTextAreaElement).value,
    ).toBe("This memory is marked private and its content is hidden.");
    expect(screen.getByRole("button", { name: "Delete memory" })).toBeTruthy();
    expect(screen.queryByText(/0123456789abcdef/)).toBeNull();
  });
  test("gates commands without a safe result and explains why", () => {
    render(
      <OverlayHost>
        <MemoryCenterPanel controller={controller({ commandGatewayAvailable: false })} />
      </OverlayHost>,
    );
    expect(screen.getByText(/omp cannot return safe results/)).toBeTruthy();
    const stats = screen.getByRole("button", { name: "Show memory stats" }) as HTMLButtonElement;
    const clear = screen.getByRole("button", { name: "Clear memory" }) as HTMLButtonElement;
    expect(stats.disabled).toBe(true);
    expect(clear.disabled).toBe(false);
  });

  test("retries a failed save without replacing the unsaved draft", () => {
    const current = controller({
      draft: "Unsaved draft.",
      draftDirty: true,
      error: new AppFailure({
        code: "conflict",
        message: "Memory changed elsewhere.",
        retryable: true,
      }),
      errorAction: "save",
    });
    render(
      <OverlayHost>
        <MemoryCenterPanel controller={current} />
      </OverlayHost>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(current.actions.save).toHaveBeenCalledTimes(1);
    expect(current.actions.refresh).not.toHaveBeenCalled();
  });

  test("retries a failed delete instead of saving a dirty draft", () => {
    const current = controller({
      draft: "Unsaved draft.",
      draftDirty: true,
      error: new AppFailure({
        code: "internal",
        message: "Memory could not be deleted.",
        retryable: true,
      }),
      errorAction: "delete",
    });
    render(
      <OverlayHost>
        <MemoryCenterPanel controller={current} />
      </OverlayHost>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(current.actions.remove).toHaveBeenCalledTimes(1);
    expect(current.actions.save).not.toHaveBeenCalled();
  });
});
