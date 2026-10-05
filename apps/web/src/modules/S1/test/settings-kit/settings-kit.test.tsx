import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  type ConfigSnapshot,
  type ConfigStoreClient,
  commit,
  preview,
  provenanceLabel,
  readSection,
  resetToEffective,
  type SettingControl,
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  secretSummary,
  stage,
  validate,
} from "../../settings-kit";

const controls: readonly SettingControl[] = [
  {
    key: "appearance.enabled",
    label: "Enabled",
    kind: "boolean",
    secret: false,
    validate: () => ({ valid: true }),
    apply: "live",
  },
  {
    key: "appearance.mode",
    label: "Mode",
    kind: "enum",
    secret: false,
    options: [
      { value: "system", label: "System" },
      { value: "dark", label: "Dark" },
    ],
    validate: (value) =>
      value.secret || value.value === "system" || value.value === "dark"
        ? { valid: true }
        : { valid: false, code: "enum", message: "Choose a supported mode." },
    apply: "reload",
    preview: () => ({ key: "appearance.mode", value: "dark", description: "Preview theme" }),
  },
  {
    key: "appearance.count",
    label: "Count",
    kind: "number",
    secret: false,
    validate: (value) =>
      !value.secret && typeof value.value === "number" && value.value >= 0
        ? { valid: true }
        : { valid: false, code: "range", message: "Must be non-negative." },
    apply: "restart",
  },
  {
    key: "appearance.notes",
    label: "Notes",
    kind: "multiline",
    secret: false,
    validate: () => ({ valid: true }),
    apply: "session",
  },
  {
    key: "provider.apiKey",
    label: "API key",
    kind: "secret",
    secret: true,
    validate: () => ({ valid: true }),
    apply: "restart",
  },
];

const descriptor: SettingsSectionDescriptor = {
  id: "S1.settingsKitTest",
  section: "appearance/Theme",
  title: "Theme settings",
  inventory: [],
  controls,
  requires: [],
};

const snapshot: ConfigSnapshot = {
  folder: null,
  revision: "rev-1",
  entries: [
    { key: "appearance.enabled", secret: false, value: true, source: "default", overrides: [] },
    {
      key: "appearance.mode",
      secret: false,
      value: "system",
      source: "global",
      overrides: ["default"],
    },
    { key: "appearance.count", secret: false, value: 1, source: "global", overrides: [] },
    { key: "appearance.notes", secret: false, value: "hello", source: "app", overrides: [] },
    { key: "provider.apiKey", secret: true, isSet: true, source: "global", overrides: [] },
  ],
};

const initial: StagedSettings = { snapshot, edits: {} };
function expectValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected settings fixture value");
  return value;
}
describe("S1 settings grammar", () => {
  test("reads one section and filters unrelated entries", async () => {
    const client: ConfigStoreClient = {
      read: async () => expectValue(snapshot.entries[0]),
      list: async () => ({
        entries: [
          ...snapshot.entries,
          { key: "other.key", secret: false, value: true, source: "default", overrides: [] },
        ],
        revision: "rev-2",
      }),
      write: async () => ({
        key: "appearance.enabled",
        layer: "global",
        folder: null,
        revision: "rev-3",
        previousRevision: "rev-2",
        entry: expectValue(snapshot.entries[0]),
      }),
    };
    const result = await readSection(client, descriptor, null);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.some((entry) => entry.key === "other.key")).toBe(false);
    expect(result.revision).toBe("rev-2");
  });

  test("stages, validates, previews and resets edits", () => {
    const staged = stage(descriptor, initial, "appearance.mode", { secret: false, value: "dark" });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.state.edits["appearance.mode"]).toEqual({ secret: false, value: "dark" });
    expect(preview(descriptor, staged.state, "appearance.mode")).toEqual({
      ok: true,
      patch: { key: "appearance.mode", value: "dark", description: "Preview theme" },
    });
    expect(resetToEffective(staged.state, "appearance.mode").edits).toEqual({});
    expect(
      validate(expectValue(controls[2]), { secret: false, value: -1 }, snapshot),
    ).toMatchObject({
      valid: false,
      code: "range",
    });
  });

  test("commits each staged key through one-key CAS and reports the strongest apply boundary", async () => {
    const writes: Array<{ key: string; expectedRevision: string; value: unknown }> = [];
    const client: ConfigStoreClient = {
      read: async () => expectValue(snapshot.entries[0]),
      list: async () => ({ entries: [...snapshot.entries], revision: snapshot.revision }),
      write: async (args) => {
        writes.push({
          key: args.key,
          expectedRevision: args.expectedRevision ?? "none",
          value: args.value,
        });
        return {
          key: args.key,
          layer: args.layer,
          folder: null,
          revision: `rev-${writes.length + 1}`,
          previousRevision: args.expectedRevision,
          entry: expectValue(
            snapshot.entries.find((entry) => entry.key === args.key) ?? snapshot.entries[0],
          ),
        };
      },
    };
    const staged = stage(descriptor, initial, "appearance.mode", { secret: false, value: "dark" });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const withCount = stage(descriptor, staged.state, "appearance.count", {
      secret: false,
      value: 2,
    });
    expect(withCount.ok).toBe(true);
    if (!withCount.ok) return;
    const result = await commit(client, descriptor, withCount.state, "global");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.expectedRevision).toBe("rev-1");
    expect(writes[1]?.expectedRevision).toBe("rev-2");
    expect(result.status).toBe("restart-required");
    expect(result.revision).toBe("rev-3");
  });

  test("exposes provenance and secret set state without a value", () => {
    const entry = expectValue(
      snapshot.entries.find((candidate) => candidate.key === "provider.apiKey"),
    );
    expect(provenanceLabel(entry)).toBe("global");
    expect(secretSummary(entry)).toEqual({ isSecret: true, isSet: true, source: "global" });
    expect("value" in entry).toBe(false);
  });
});

describe("S1 settings section", () => {
  test("renders every control type, provenance and secret set/unset only", () => {
    const { container } = render(<SettingsSection descriptor={descriptor} snapshot={snapshot} />);
    expect(screen.getByText("Theme settings")).toBeTruthy();
    expect(screen.getByText("Source: global · overrides default")).toBeTruthy();
    expect(screen.getByTestId("provider.apiKey-secret-status").textContent).toContain("Set");
    expect(screen.getByRole("button", { name: "Replace…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unset" })).toBeTruthy();
    expect(container.textContent).not.toContain("value");
    expect(screen.queryByPlaceholderText(/api key|secret|token/i)).toBeNull();
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("spinbutton")).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});
