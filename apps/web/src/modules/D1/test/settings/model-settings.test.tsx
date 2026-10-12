import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingValue, StageResult } from "@/modules/S1/settings-kit";
import type { SettingsRuntime, SettingsRuntimeSnapshot } from "../../../S1/runtime";
import { modelSettingsSections } from "../../settings/descriptors";
import { ModelSettingsSection } from "../../settings/model-settings";

function runtime(
  descriptor: (typeof modelSettingsSections)[number],
  phase: SettingsRuntimeSnapshot["phase"] = "ready",
): SettingsRuntime {
  const config: ConfigSnapshot = {
    folder: null,
    revision: descriptor.id,
    entries: descriptor.controls.map((control) => ({
      key: control.key,
      secret: false,
      value: control.kind === "boolean" ? false : control.kind === "number" ? 0 : "",
      source: "global",
      overrides: [],
    })),
  };
  const snapshot: SettingsRuntimeSnapshot = {
    folder: null,
    descriptor,
    layer: "global",
    config,
    staged: { snapshot: config, edits: {} },
    validation: {},
    phase,
    conflict:
      phase === "conflict"
        ? { local: { snapshot: config, edits: {} }, remote: config, changedKeys: ["modelRoles"] }
        : null,
    error: null,
    applyStatus: null,
    environmentOverride: null,
    lastChange: null,
    unsavedKeys: [],
  };
  const listeners = new Set<(next: SettingsRuntimeSnapshot) => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: (next: SettingsRuntimeSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: async () => config,
    stage: (_key: string, _value: SettingValue): StageResult => ({
      ok: true,
      state: { snapshot: config, edits: {} },
    }),
    save: async () => undefined,
    cancel: () => undefined,
    retry: async () => config,
    resolveConflict: () => undefined,
  } as unknown as SettingsRuntime;
}

afterEach(cleanup);

describe("D1 model settings sections", () => {
  test("exports exactly the six D1-owned S2 model sections and key groups", () => {
    expect(modelSettingsSections.map((section) => section.section)).toEqual([
      "model/Thinking",
      "model/Sampling",
      "model/Prompt",
      "model/Retry & Fallback",
      "model/Prewalk",
      "model/Vision",
    ]);
    expect(modelSettingsSections[0]?.controls.map((control) => control.key)).toContain(
      "defaultThinkingLevel",
    );
    expect(modelSettingsSections[1]?.controls.map((control) => control.key)).toContain(
      "temperature",
    );
    expect(modelSettingsSections[0]?.controls.map((control) => control.key)).toContain(
      "modelRoleStorage",
    );
    expect(modelSettingsSections[2]?.controls.map((control) => control.key)).not.toContain(
      "modelRoleStorage",
    );
    expect(modelSettingsSections[3]?.controls.map((control) => control.key)).toContain(
      "retry.modelFallback",
    );
    expect(modelSettingsSections[4]?.controls.map((control) => control.key)).toEqual([
      "prewalk.enabled",
    ]);
    expect(modelSettingsSections[5]?.controls.map((control) => control.key)).toEqual([
      "images.describeForTextModels",
    ]);
  });

  test("renders all six sections and offers explicit conflict choices", () => {
    render(
      <div>
        {modelSettingsSections.map((descriptor) => (
          <ModelSettingsSection
            key={descriptor.id}
            descriptor={descriptor}
            runtime={runtime(descriptor)}
          />
        ))}
      </div>,
    );
    for (const title of ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Prewalk", "Vision"])
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);

    cleanup();
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection descriptor={descriptor} runtime={runtime(descriptor, "conflict")} />,
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep mine" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  });
});
