import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ConfigSnapshot,
  SettingValue,
  StagedSettings,
  StageResult,
} from "@/modules/S1/settings-kit";
import type { SettingsRuntime, SettingsRuntimeSnapshot } from "../../../S1/runtime";
import { modelSettingsSections } from "../../settings/descriptors";
import { ModelSettingsSection } from "../../settings/model-settings";

const REFUSAL =
  "This setting could not be written to the settings file. Check the settings file for an entry that conflicts with it.";

/** One staged Thinking Level change: Save is enabled unless something holds it. */
const thinkingEdit: StagedSettings["edits"] = {
  defaultThinkingLevel: { secret: false, value: "high" },
};

function runtime(
  descriptor: (typeof modelSettingsSections)[number],
  phase: SettingsRuntimeSnapshot["phase"] = "ready",
  patch: Partial<SettingsRuntimeSnapshot> = {},
  edits: StagedSettings["edits"] = {},
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
    staged: { snapshot: config, edits },
    validation: {},
    phase,
    conflict:
      phase === "conflict"
        ? {
            local: { snapshot: config, edits },
            remote: config,
            changedKeys: ["defaultThinkingLevel"],
          }
        : null,
    error: null,
    applyStatus: null,
    environmentOverride: null,
    lastChange: null,
    unsavedKeys: [],
    ...patch,
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
    expect(modelSettingsSections[3]?.controls.map((control) => control.key)).toEqual(
      expect.arrayContaining(["retry.modelFallback", "retry.fallbackChains"]),
    );
    expect(modelSettingsSections[4]?.controls.map((control) => control.key)).toEqual([
      "prewalk.enabled",
    ]);
    expect(modelSettingsSections[5]?.controls.map((control) => control.key)).toEqual([
      "images.describeForTextModels",
      "images.urls.enabled",
      "images.urls.backends",
      "images.urls.command",
      "images.urls.publicBaseUrl",
      "images.urls.ttlHours",
      "images.urls.bindHost",
      "images.urls.sshTarget",
      "images.urls.sshRemotePort",
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
    expect(screen.getByRole("button", { name: "Reload latest" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep my edits" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
  });

  test("says a session-only and an unsupported change in the words the other settings tabs use", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "ready", { applyStatus: "session-only" })}
      />,
    );
    expect(screen.getByText("This session only")).toBeTruthy();
    expect(screen.queryByText("Session only")).toBeNull();
    cleanup();
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "ready", { applyStatus: "unsupported" })}
      />,
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("Unsupported")).toBeNull();
  });

  test("names the settings omp did not save, with the reason, and marks their rows", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "editing", {
          unsavedKeys: ["defaultThinkingLevel"],
          error: new AppFailure({ code: "invalid_args", message: REFUSAL, retryable: false })
            .appError,
        })}
      />,
    );
    expect(screen.getByText("Not saved: Thinking Level.")).toBeTruthy();
    expect(screen.getByText(REFUSAL)).toBeTruthy();
    expect(screen.getByText("Not saved", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Applied")).toBeNull();
  });

  test("says in a sentence that the environment still overrides a saved setting, not Applied", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "ready", {
          applyStatus: "applied",
          environmentOverride: { variables: ["PI_EXAMPLE"] },
        })}
      />,
    );
    expect(
      screen.getByText(
        "Saved, but omp still uses the environment variable PI_EXAMPLE until it is removed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Applied")).toBeNull();
  });

  test("keeps a status other than Applied beside the environment sentence", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "ready", {
          applyStatus: "restart-required",
          environmentOverride: { variables: ["PI_EXAMPLE"] },
        })}
      />,
    );
    expect(screen.getByText("Restart required")).toBeTruthy();
    expect(
      screen.getByText(/Saved, but omp still uses the environment variable PI_EXAMPLE/),
    ).toBeTruthy();
  });

  test("shows a failure that names no unsaved setting as an error beside the section", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "ready", {
          error: new AppFailure({ code: "invalid_args", message: REFUSAL, retryable: false })
            .appError,
        })}
      />,
    );
    expect(screen.getByText(REFUSAL)).toBeTruthy();
    expect(screen.queryByText(/^Not saved/)).toBeNull();
  });

  test("the fields and Save stay enabled for a staged edit while nothing is saving", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "editing", {}, thinkingEdit)}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Thinking Level" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  test("the fields, Save and Cancel are disabled while a save writes", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "saving", {}, thinkingEdit)}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Thinking Level" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  });

  test("a conflict with an earlier apply status shows one shared card and keeps its choices", () => {
    const descriptor = modelSettingsSections[0];
    if (!descriptor) throw new Error("missing thinking section");
    render(
      <ModelSettingsSection
        descriptor={descriptor}
        runtime={runtime(descriptor, "conflict", { applyStatus: "restart-required" }, thinkingEdit)}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Thinking Level" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Reload latest" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Keep my edits" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getAllByRole("heading", { name: "Settings changed elsewhere" })).toHaveLength(1);
    expect(
      screen.getByText(
        "Another change arrived while this section was open. Reload the latest values or keep your edits and save again.",
        { exact: true },
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Restart required", { exact: true })).toBeNull();
  });
});
