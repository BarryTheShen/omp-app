import type { ConfigEntry, JsonValue } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  applyStatusLabel,
  CONFLICT_BUTTON_LABELS,
  type ConfigSnapshot,
  type ConfigStoreClient,
  commit,
  environmentOverrideOf,
  environmentOverrideText,
  type MapSettingControl,
  preview,
  provenanceLabel,
  type RowsSettingControl,
  readSection,
  resetToEffective,
  type SettingControl,
  SettingsSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  secretSummary,
  settingsConflictRows,
  stage,
  structuredDrafts,
  structuredValue,
  validate,
} from "../../settings-kit";

afterEach(cleanup);

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
    expect(provenanceLabel(entry)).toBe("Saved for all projects");
    expect(secretSummary(entry)).toEqual({ isSecret: true, isSet: true, source: "global" });
    expect("value" in entry).toBe(false);
  });
  test("builds conflict rows keyed by setting and keeps secret values private", () => {
    const rows = settingsConflictRows(descriptor, snapshot, [
      "appearance.enabled",
      "appearance.mode",
      "provider.apiKey",
    ]);

    expect(rows).toEqual([
      {
        key: "appearance.enabled",
        label: "Enabled",
        value: "On · Source: omp's default",
      },
      {
        key: "appearance.mode",
        label: "Mode",
        value: "System · Source: Saved for all projects · overrides omp's default",
      },
      {
        key: "provider.apiKey",
        label: "API key",
        value: "Set · Source: Saved for all projects",
      },
    ]);
  });
  test("uses plain English for every source and overridden layer", () => {
    const entry = expectValue(
      snapshot.entries.find((candidate) => candidate.key === "provider.apiKey"),
    );
    const sources: readonly [ConfigEntry["source"], string][] = [
      ["env", "Set in the environment"],
      ["runtime", "Set for this run"],
      ["overlay", "Set in an additional config file"],
      ["project", "Saved for this project"],
      ["global", "Saved for all projects"],
      ["default", "omp's default"],
      ["app", "Saved in this app only"],
    ];

    for (const [source, label] of sources) {
      expect(provenanceLabel({ ...entry, source, overrides: [] })).toBe(label);
    }
    expect(provenanceLabel({ ...entry, source: "project", overrides: ["global", "default"] })).toBe(
      "Saved for this project · overrides settings for all projects, omp's default",
    );
  });
});

describe("S1 settings section", () => {
  test("renders every control type, provenance and secret set/unset only", () => {
    const { container } = render(<SettingsSection descriptor={descriptor} snapshot={snapshot} />);
    expect(screen.getByText("Theme settings")).toBeTruthy();
    expect(
      screen.getByText("Source: Saved for all projects · overrides omp's default"),
    ).toBeTruthy();
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

  test("unrecognized stored values name their recovery choices and return focus to the control", async () => {
    const malformed: ConfigSnapshot = {
      ...snapshot,
      entries: snapshot.entries.map((entry) =>
        entry.key === "appearance.enabled"
          ? { ...entry, value: "yes" }
          : entry.key === "appearance.mode"
            ? { ...entry, value: "bogus" }
            : entry,
      ),
    };
    function Harness() {
      const [staged, setStaged] = useState<StagedSettings>({ snapshot: malformed, edits: {} });
      return (
        <SettingsSection
          descriptor={descriptor}
          snapshot={malformed}
          staged={staged}
          onStage={setStaged}
        />
      );
    }

    render(<Harness />);
    expect(screen.getAllByText("This setting has an unrecognized value.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use System" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(checkbox));
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Use System" }));
    const mode = screen.getByRole("combobox", { name: "Mode" }) as HTMLSelectElement;
    await waitFor(() => expect(document.activeElement).toBe(mode));
    expect(mode.value).toBe("system");
  });

  test("keeps the unconfigured source label unchanged", () => {
    render(<SettingsSection descriptor={descriptor} snapshot={{ ...snapshot, entries: [] }} />);
    expect(screen.getAllByText("Source: not configured")).toHaveLength(controls.length);
  });

  test("draws list controls inside the card, after the rows and above Save and Cancel", () => {
    render(
      <SettingsSection
        descriptor={descriptor}
        snapshot={snapshot}
        onCommit={() => undefined}
        onCancel={() => undefined}
        listControls={<p>Folder list editor</p>}
      />,
    );
    const card = screen.getByRole("region", { name: descriptor.title });
    const list = within(card).getByText("Folder list editor");
    const save = within(card).getByRole("button", { name: "Save changes" });
    const cancel = within(card).getByRole("button", { name: "Cancel" });
    expect(list.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("shows a value the server hid as a sentence, not an empty box, with its source", () => {
    const endpoint: SettingControl = {
      key: "dev.autoqaPush.endpoint",
      label: "Auto QA Push Endpoint",
      kind: "text",
      secret: false,
      validate: () => ({ valid: true }),
      apply: "live",
    };
    render(
      <SettingsSection
        descriptor={{ ...descriptor, controls: [endpoint] }}
        snapshot={{
          ...snapshot,
          entries: [
            {
              key: "dev.autoqaPush.endpoint",
              secret: true,
              isSet: true,
              source: "env",
              overrides: ["default"],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Set in the environment; the value is hidden.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Auto QA Push Endpoint" })).toBeNull();
    expect(
      screen.getByText("Source: Set in the environment · overrides omp's default"),
    ).toBeTruthy();
  });

  test("a number the setting refuses, or an emptied field, stays in the field under the setting's message and blocks Save", () => {
    function Harness() {
      const [staged, setStaged] = useState<StagedSettings>(initial);
      return (
        <SettingsSection
          descriptor={descriptor}
          snapshot={snapshot}
          staged={staged}
          onStage={setStaged}
          onCommit={() => undefined}
          onCancel={() => setStaged(initial)}
        />
      );
    }
    render(<Harness />);
    const count = () => screen.getByLabelText("Count") as HTMLInputElement;
    const save = () => screen.getByRole("button", { name: "Save changes" });

    fireEvent.change(count(), { target: { value: "-1" } });
    expect(screen.getByRole("alert").textContent).toBe("Must be non-negative.");
    expect(count().value).toBe("-1");
    expect(save()).toHaveProperty("disabled", true);

    // An emptied field is not 0: it is refused, not saved without a word.
    fireEvent.change(count(), { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toBe("Must be non-negative.");
    expect(count().value).toBe("");
    expect(save()).toHaveProperty("disabled", true);

    fireEvent.change(count(), { target: { value: "3" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(count().value).toBe("3");
    expect(save()).toHaveProperty("disabled", false);

    // Cancel puts the saved value back, with no message.
    fireEvent.change(count(), { target: { value: "-2" } });
    expect(count().value).toBe("-2");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(count().value).toBe("1");
  });

  test("a list setting keeps the comma a person types, so a second item can be typed", () => {
    const exempt: SettingControl = {
      key: "model.exemptTools",
      label: "Exempt Tools",
      kind: "list",
      secret: false,
      validate: (value) =>
        !value.secret && Array.isArray(value.value)
          ? { valid: true }
          : { valid: false, code: "list", message: "Enter a comma-separated list." },
      apply: "restart",
    };
    const listSnapshot: ConfigSnapshot = {
      folder: null,
      revision: "rev-1",
      entries: [
        {
          key: "model.exemptTools",
          secret: false,
          value: ["bash"],
          source: "global",
          overrides: [],
        },
      ],
    };
    const listDescriptor: SettingsSectionDescriptor = { ...descriptor, controls: [exempt] };
    const listInitial: StagedSettings = { snapshot: listSnapshot, edits: {} };
    function Harness() {
      const [staged, setStaged] = useState<StagedSettings>(listInitial);
      const edit = staged.edits["model.exemptTools"];
      return (
        <>
          <SettingsSection
            descriptor={listDescriptor}
            snapshot={listSnapshot}
            staged={staged}
            onStage={setStaged}
            onCancel={() => setStaged(listInitial)}
          />
          <output data-testid="staged">
            {JSON.stringify(edit && !edit.secret ? edit.value : null)}
          </output>
          <button
            type="button"
            onClick={() =>
              setStaged({
                snapshot: listSnapshot,
                edits: { "model.exemptTools": { secret: false, value: ["write"] } },
              })
            }
          >
            Outside change
          </button>
        </>
      );
    }
    render(<Harness />);
    const field = screen.getByLabelText("Exempt Tools") as HTMLInputElement;
    const stagedOutput = screen.getByTestId("staged");

    // Typed one key at a time: the comma and the space after it stay in the field, and the list follows the text.
    fireEvent.change(field, { target: { value: "read" } });
    fireEvent.change(field, { target: { value: "read," } });
    expect(field.value).toBe("read,");
    fireEvent.change(field, { target: { value: "read, " } });
    expect(field.value).toBe("read, ");
    fireEvent.change(field, { target: { value: "read, w" } });
    fireEvent.change(field, { target: { value: "read, write" } });
    expect(field.value).toBe("read, write");
    expect(stagedOutput.textContent).toBe('["read","write"]');

    // Backspace from the second item back to the comma keeps the comma.
    fireEvent.change(field, { target: { value: "read," } });
    expect(field.value).toBe("read,");
    expect(stagedOutput.textContent).toBe('["read"]');

    // A list that is not the typed text (here, one set from elsewhere) replaces it in the field.
    fireEvent.change(field, { target: { value: "read, x" } });
    fireEvent.click(screen.getByRole("button", { name: "Outside change" }));
    expect(field.value).toBe("write");

    // Cancel drops the typed text and shows the saved list.
    fireEvent.change(field, { target: { value: "read," } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(field.value).toBe("bash");
  });
});

describe("S1 structured settings", () => {
  const limits: MapSettingControl = {
    key: "providers.maxInFlightRequests",
    label: "Max In-Flight Requests",
    kind: "map",
    secret: false,
    keyLabel: "Provider name",
    value: { label: "Request limit", kind: "number", positive: true },
    addLabel: "Add provider",
    emptyLabel: "No provider-specific limits",
    validate: () => ({ valid: true }),
    apply: "live",
  };
  const rules: RowsSettingControl = {
    key: "bash.patterns",
    label: "Bash Approval Patterns",
    kind: "rows",
    secret: false,
    fields: {
      match: { label: "Command pattern", kind: "text" },
      approval: {
        label: "Approval",
        kind: "enum",
        options: [
          { value: "prompt", label: "Ask first" },
          { value: "allow", label: "Allow" },
        ],
      },
    },
    ordered: true,
    addLabel: "Add rule",
    emptyLabel: "No approval rules",
    validate: () => ({ valid: true }),
    apply: "reload",
  };
  const structuredDescriptor: SettingsSectionDescriptor = {
    ...descriptor,
    controls: [limits, rules],
  };
  const entry = (key: string, value: JsonValue): ConfigEntry => ({
    key,
    secret: false,
    value,
    source: "global",
    overrides: [],
  });
  const structuredSnapshot: ConfigSnapshot = {
    folder: null,
    revision: "r1",
    entries: [
      entry("providers.maxInFlightRequests", { openai: 4 }),
      entry("bash.patterns", [
        { match: "git push *", approval: "prompt" },
        { match: "ls *", approval: "allow" },
      ]),
    ],
  };

  test("turns rows into a value and reports the first problem in plain English", () => {
    expect(structuredDrafts(limits, { openai: 4, anthropic: 2 })).toEqual([
      { key: "anthropic", value: "2" },
      { key: "openai", value: "4" },
    ]);
    expect(structuredValue(limits, [{ key: " openai ", value: "4" }])).toEqual({
      ok: true,
      value: { openai: 4 },
    });
    // A row added but not typed in yet doesn't count; a half-filled one does.
    expect(structuredValue(limits, [{ key: "", value: "" }])).toEqual({ ok: true, value: {} });
    expect(structuredValue(limits, [{ key: "", value: "4" }])).toMatchObject({
      ok: false,
      validation: { message: "Enter a provider name." },
    });
    expect(
      structuredValue(limits, [
        { key: "openai", value: "4" },
        { key: "openai", value: "2" },
      ]),
    ).toMatchObject({ ok: false, validation: { message: "Provider names must be unique." } });
    expect(structuredValue(limits, [{ key: "openai", value: "0" }])).toMatchObject({
      ok: false,
      validation: { message: "Enter a positive request limit." },
    });
    expect(structuredValue(rules, [{ match: "git *", approval: "allow" }])).toEqual({
      ok: true,
      value: [{ match: "git *", approval: "allow" }],
    });
    expect(structuredValue(rules, [{ match: "git *", approval: "sometimes" }])).toMatchObject({
      ok: false,
      validation: { message: "Choose an approval." },
    });
  });
  test("round-trips collapsed single selectors and selector lists", () => {
    const modelSelectors: MapSettingControl = {
      ...limits,
      key: "task.agentModelOverrides",
      label: "Agent Model Overrides",
      description: "Choose a model selector or ordered list for an agent.",
      keyLabel: "Agent name",
      keyPlaceholder: "Agent name",
      value: {
        label: "Model selector",
        kind: "list",
        placeholder: "provider/model, provider/model",
        collapseSingle: true,
      },
      addLabel: "Add model override",
      emptyLabel: "No per-agent model overrides",
    };
    expect(structuredDrafts(modelSelectors, { task: "@task" })).toEqual([
      { key: "task", value: "@task" },
    ]);
    expect(structuredValue(modelSelectors, [{ key: "task", value: "@task" }])).toEqual({
      ok: true,
      value: { task: "@task" },
    });
    expect(structuredDrafts(modelSelectors, { task: ["@fast", "provider/model"] })).toEqual([
      { key: "task", value: "@fast, provider/model" },
    ]);
    expect(
      structuredValue(modelSelectors, [{ key: "task", value: "@fast, provider/model" }]),
    ).toEqual({ ok: true, value: { task: ["@fast", "provider/model"] } });
    expect(
      structuredValue(modelSelectors, [{ key: "task", value: "@fast, , provider/model" }]),
    ).toEqual({
      ok: true,
      value: { task: ["@fast", "provider/model"] },
    });

    expect(structuredValue(modelSelectors, [{ key: "", value: "" }])).toEqual({
      ok: true,
      value: {},
    });
    expect(structuredValue(modelSelectors, [{ key: "task", value: "" }])).toMatchObject({
      ok: false,
      validation: { message: "Enter a model selector." },
    });
  });

  test("uses the configured placeholder for a list field", () => {
    const modelSelectors: MapSettingControl = {
      ...limits,
      key: "task.agentModelOverrides",
      label: "Agent Model Overrides",
      keyLabel: "Agent name",
      value: {
        label: "Model selector",
        kind: "list",
        placeholder: "provider/model, provider/model",
        collapseSingle: true,
      },
      addLabel: "Add model override",
      emptyLabel: "No per-agent model overrides",
    };
    const modelDescriptor = { ...descriptor, controls: [modelSelectors] };
    const modelSnapshot: ConfigSnapshot = {
      ...structuredSnapshot,
      entries: [entry("task.agentModelOverrides", { task: ["@fast", "provider/model"] })],
    };
    render(<SettingsSection descriptor={modelDescriptor} snapshot={modelSnapshot} />);
    expect(screen.getByPlaceholderText("provider/model, provider/model")).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Agent Model Overrides: Model selector 1" }),
    ).toBeTruthy();
  });

  test("edits a map in place: add, change, remove, and blocks Save while a row is wrong", async () => {
    const stagedValues: JsonValue[] = [];
    function Harness() {
      const [staged, setStaged] = useState<StagedSettings>({
        snapshot: structuredSnapshot,
        edits: {},
      });
      return (
        <SettingsSection
          descriptor={structuredDescriptor}
          snapshot={structuredSnapshot}
          staged={staged}
          onStage={(next) => {
            const value = next.edits["providers.maxInFlightRequests"];
            if (value && !value.secret) stagedValues.push(value.value);
            setStaged(next);
          }}
          onCommit={() => undefined}
          onCancel={() => setStaged({ snapshot: structuredSnapshot, edits: {} })}
        />
      );
    }
    render(<Harness />);
    const save = () => screen.getByRole("button", { name: "Save changes" });
    expect(screen.getByLabelText("Max In-Flight Requests: Provider name 1")).toHaveProperty(
      "value",
      "openai",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByLabelText("Max In-Flight Requests: Request limit 2"), {
      target: { value: "2" },
    });
    expect(screen.getByRole("alert").textContent).toBe("Enter a provider name.");
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Max In-Flight Requests: Provider name 2"), {
      target: { value: "anthropic" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stagedValues.at(-1)).toEqual({ openai: 4, anthropic: 2 });
    expect(save()).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Remove openai" }));
    expect(stagedValues.at(-1)).toEqual({ anthropic: 2 });
    // Cancel drops the rows being edited and shows the stored value again.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Max In-Flight Requests: Provider name 1")).toHaveProperty(
      "value",
      "openai",
    );
    expect(screen.queryByLabelText("Max In-Flight Requests: Provider name 2")).toBeNull();
  });

  test("moves ordered rows and stages the new order", () => {
    const stagedValues: JsonValue[] = [];
    function Harness() {
      const [staged, setStaged] = useState<StagedSettings>({
        snapshot: structuredSnapshot,
        edits: {},
      });
      return (
        <SettingsSection
          descriptor={structuredDescriptor}
          snapshot={structuredSnapshot}
          staged={staged}
          onStage={(next) => {
            const value = next.edits["bash.patterns"];
            if (value && !value.secret) stagedValues.push(value.value);
            setStaged(next);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Move row 1 up" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Move row 2 up" }));
    expect(stagedValues.at(-1)).toEqual([
      { match: "ls *", approval: "allow" },
      { match: "git push *", approval: "prompt" },
    ]);
  });

  test("shows a read-only setting as text with where to change it, and refuses to stage it", () => {
    const readOnly: MapSettingControl = {
      ...limits,
      readOnly: { reason: "Change this in omp's settings file." },
    };
    const readOnlyDescriptor = { ...descriptor, controls: [readOnly] };
    render(<SettingsSection descriptor={readOnlyDescriptor} snapshot={structuredSnapshot} />);
    expect(screen.getByText("openai: 4")).toBeTruthy();
    expect(screen.getByText("Change this in omp's settings file.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    const result = stage(
      readOnlyDescriptor,
      { snapshot: structuredSnapshot, edits: {} },
      readOnly.key,
      {
        secret: false,
        value: { openai: 1 },
      },
    );
    expect(result).toMatchObject({ ok: false, validation: { code: "read-only" } });
  });
});

describe("S1 environment overrides after a save", () => {
  test("names the variable that overrides a saved setting, and says omp still uses it", () => {
    const entries: ConfigEntry[] = [
      {
        key: "appearance.enabled",
        secret: false,
        value: true,
        source: "env",
        overrides: ["global"],
        overriddenBy: "PI_APPEARANCE_ENABLED",
      },
      { key: "appearance.mode", secret: false, value: "system", source: "global", overrides: [] },
      { key: "appearance.notes", secret: false, value: "hi", source: "env", overrides: [] },
    ];
    expect(environmentOverrideOf(entries, ["appearance.enabled", "appearance.mode"])).toEqual({
      variables: ["PI_APPEARANCE_ENABLED"],
    });
    expect(environmentOverrideOf(entries, ["appearance.mode"])).toBeNull();
    // An environment value whose variable is not named still says omp uses it.
    expect(environmentOverrideOf(entries, ["appearance.notes"])).toEqual({ variables: [] });
    expect(environmentOverrideText({ variables: ["PI_AUTO_QA"] })).toBe(
      "Saved, but omp still uses the environment variable PI_AUTO_QA until it is removed.",
    );
    expect(environmentOverrideText({ variables: ["PI_AUTO_QA", "PI_INTENT_TRACING"] })).toBe(
      "Saved, but omp still uses the environment variables PI_AUTO_QA and PI_INTENT_TRACING until they are removed.",
    );
    expect(environmentOverrideText({ variables: ["A", "B", "C"] })).toBe(
      "Saved, but omp still uses the environment variables A, B and C until they are removed.",
    );
    expect(environmentOverrideText({ variables: [] })).toBe(
      "Saved, but omp still uses the value from the environment until the variable is removed.",
    );
  });
});
describe("shared settings status and conflict wording", () => {
  test("keeps each apply status and conflict action's words stable", () => {
    expect(
      (
        ["applied", "session-only", "reload-required", "restart-required", "unsupported"] as const
      ).map(applyStatusLabel),
    ).toEqual([
      "Applied",
      "This session only",
      "Reload required",
      "Restart required",
      "Unavailable",
    ]);
    expect(CONFLICT_BUTTON_LABELS).toEqual({
      reload: "Reload latest",
      keepMine: "Keep my edits",
    });
  });
});
