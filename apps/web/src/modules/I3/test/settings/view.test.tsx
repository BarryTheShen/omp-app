import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ConfigSnapshot } from "../../../S1/settings-kit";
import { SETTINGS_CONFLICT_DESCRIPTION, SETTINGS_CONFLICT_HEADING } from "../../../S1/settings-kit";
import type { MemorySettingsActions, MemorySettingsViewModel } from "../../settings";
import {
  MEMORY_GENERAL_SETTINGS_SECTION,
  MEMORY_HINDSIGHT_SETTINGS_SECTION,
  MemorySettingsView,
} from "../../settings";

function model(
  section = MEMORY_GENERAL_SETTINGS_SECTION,
  conflict = false,
): MemorySettingsViewModel {
  const config: ConfigSnapshot = { folder: null, revision: "r1", entries: [] };
  const snapshot = {
    descriptor: section,
    folder: null,
    layer: "global" as const,
    config,
    staged: { snapshot: config, edits: {} },
    validation: {},
    phase: conflict ? ("conflict" as const) : ("ready" as const),
    conflict: conflict
      ? { local: { snapshot: config, edits: {} }, remote: config, changedKeys: [] }
      : null,
    error: null,
    applyStatus: null,
    environmentOverride: null,
    lastChange: null,
    unsavedKeys: [],
  };
  return {
    sections: [{ descriptor: section, snapshot, validation: {} }],
    activeSectionId: section.id,
  };
}

function actions(): MemorySettingsActions {
  return {
    onSelectSection: vi.fn(),
    onStage: vi.fn(),
    onPreview: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onSecretAction: vi.fn(),
    onResolveConflict: vi.fn(),
  };
}

describe("I3 memory settings view", () => {
  test("opens a credential editor and stages only the typed value", () => {
    const handlers = actions();
    render(
      <MemorySettingsView model={model(MEMORY_HINDSIGHT_SETTINGS_SECTION)} actions={handlers} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set…" }));
    fireEvent.change(screen.getByLabelText("API Token"), { target: { value: "secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(handlers.onStage).toHaveBeenCalledWith(
      "I3.memoryHindsight",
      expect.objectContaining({
        edits: { "hindsight.apiToken": { secret: true, action: "set", value: "secret-value" } },
      }),
    );
  });

  test("renders conflict recovery actions instead of locking the section", () => {
    const handlers = actions();
    render(
      <MemorySettingsView
        model={model(MEMORY_GENERAL_SETTINGS_SECTION, true)}
        actions={handlers}
      />,
    );
    expect(screen.getByText(SETTINGS_CONFLICT_HEADING)).toBeTruthy();
    expect(screen.getByText(SETTINGS_CONFLICT_DESCRIPTION)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    expect(handlers.onResolveConflict).toHaveBeenNthCalledWith(1, "I3.memoryGeneral", "reload");
    expect(handlers.onResolveConflict).toHaveBeenNthCalledWith(2, "I3.memoryGeneral", "keep-mine");
  });
});
