import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type ConfigChanged,
  type ConfigEntry,
  type ConfigWriteResult,
  JsonValue,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigStoreClient } from "@/modules/S1/settings-kit";
import { SettingsScreen } from "./settings-screen";

const REFUSAL =
  "This setting could not be written to the settings file. Check the settings file for an entry that conflicts with it.";

const CAPABILITIES: CapabilityMap = { "host.config": { state: "available", via: "host" } };

type FakeConfig = {
  revision: string;
  entries: ConfigEntry[];
  /** Keys omp refuses to write, as a settings file with a conflicting entry does. */
  refused: ReadonlySet<string>;
  /** How many reads fail from now on. */
  failingReads: number;
  /** The keys written, in order. */
  writes: string[];
  /** Layers used for writes, in order. */
  writeLayers: string[];
  /** Optional changed-event listeners for refresh tests. */
  listeners?: Set<(change: ConfigChanged) => void>;
  /** Environment variables that supply a written key's value, by key: the write then reports that source. */
  environmentKeys?: Readonly<Record<string, string>>;
  writeFailure?: unknown;
};

function fakeConfigStore(state: FakeConfig): ConfigStoreClient {
  return {
    async read({ key }) {
      const entry = state.entries.find((item) => item.key === key);
      if (!entry)
        throw new AppFailure({ code: "not_found", message: "Setting missing", retryable: false });
      return entry;
    },
    async list() {
      if (state.failingReads > 0) {
        state.failingReads -= 1;
        throw new AppFailure({
          code: "unavailable",
          message: "The settings file could not be read.",
          retryable: true,
        });
      }
      return { entries: [...state.entries], revision: state.revision };
    },
    async write(args): Promise<ConfigWriteResult> {
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "The settings changed elsewhere.",
          retryable: true,
        });
      }
      if (state.refused.has(args.key)) {
        throw new AppFailure({ code: "invalid_args", message: REFUSAL, retryable: false });
      }
      if (args.value.secret !== false) {
        throw new Error("The notification settings are not secrets.");
      }
      if (state.writeFailure !== undefined) throw state.writeFailure;
      state.writes.push(args.key);
      state.writeLayers.push(args.layer);
      const revision = `revision-${state.writes.length + 1}`;
      const variable = state.environmentKeys?.[args.key];
      const entry: ConfigEntry = {
        key: args.key,
        secret: false,
        value: JsonValue.parse(args.value.value),
        source: variable === undefined ? args.layer : "env",
        overrides: [],
        ...(variable === undefined ? {} : { overriddenBy: variable }),
      };
      state.revision = revision;
      const index = state.entries.findIndex((item) => item.key === args.key);
      state.entries[index] = entry;
      return {
        key: args.key,
        layer: args.layer,
        folder: null,
        revision,
        previousRevision: args.expectedRevision,
        entry,
      };
    },
  };
}

/** The app's client, with only the configuration store the settings screen reads and writes. */
function fakeAppClient(state: FakeConfig): AppClient {
  const port = fakeConfigStore(state);
  return {
    port: () => port,
    subscribe: async () => ({
      stream: "A1.configStore.changed:global",
      lastSeq: 0,
      onEvent: (listener: (change: ConfigChanged) => void) => {
        state.listeners ??= new Set();
        state.listeners.add(listener);
        return () => state.listeners?.delete(listener);
      },
      unsubscribe: async () => undefined,
    }),
  } as unknown as AppClient;
}

function notificationsConfig(refused: readonly string[]): FakeConfig {
  return {
    revision: "revision-1",
    entries: [
      { key: "completion.notify", secret: false, value: "on", source: "global", overrides: [] },
      { key: "error.notify", secret: false, value: "on", source: "global", overrides: [] },
      {
        key: "power.sleepPrevention",
        secret: false,
        value: "off",
        source: "default",
        overrides: [],
      },
    ],
    refused: new Set(refused),
    failingReads: 0,
    writes: [],
    writeLayers: [],
  };
}

beforeEach(() => {
  // The theme hook reads the system's colour scheme, which jsdom does not provide.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows Git and Power settings when configuration is available", async () => {
  const state = notificationsConfig([]);
  render(
    <SettingsScreen
      client={fakeAppClient(state)}
      capabilities={CAPABILITIES}
      folder={null}
      onClose={() => undefined}
      threadId={null}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Interaction" }));
  fireEvent.click(await screen.findByRole("option", { name: "Git" }));
  expect(await screen.findByRole("checkbox", { name: "Enable Git Integration" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("option", { name: "Power" }));
  expect(await screen.findByRole("combobox", { name: "Sleep Prevention" })).toBeTruthy();
});
test("keeps the save-location buttons disabled while a generic section is dirty", async () => {
  const state = notificationsConfig([]);
  const onUnsavedChange = vi.fn();
  render(
    <SettingsScreen
      client={fakeAppClient(state)}
      capabilities={CAPABILITIES}
      folder={"/workspace" as never}
      onClose={() => undefined}
      onUnsavedChange={onUnsavedChange}
      threadId={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Interaction" }));
  fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
  await screen.findByRole("combobox", { name: "Error Notification" });
  await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(false));

  fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
    target: { value: "off" },
  });
  expect(screen.getByRole("button", { name: "All workspaces" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByRole("button", { name: "This workspace" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(
    screen.getByText("Save or cancel staged changes before changing where they are saved."),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(false));
  expect(onUnsavedChange.mock.calls.map(([dirty]) => dirty)).toEqual([false, true, false]);
  expect(screen.getByRole("button", { name: "All workspaces" }).hasAttribute("disabled")).toBe(
    false,
  );
  expect(screen.getByRole("button", { name: "This workspace" }).hasAttribute("disabled")).toBe(
    false,
  );
});

test("writes a generic section to the selected workspace layer", async () => {
  const state = notificationsConfig([]);
  render(
    <SettingsScreen
      client={fakeAppClient(state)}
      capabilities={CAPABILITIES}
      folder={"/workspace" as never}
      onClose={() => undefined}
      threadId={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Interaction" }));
  fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
  await screen.findByRole("combobox", { name: "Error Notification" });
  fireEvent.click(screen.getByRole("button", { name: "This workspace" }));
  await screen.findByRole("combobox", { name: "Error Notification" });
  fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
    target: { value: "off" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(state.writes).toEqual(["completion.notify"]));
  expect(state.writeLayers).toEqual(["project"]);
});

test("does not offer Retry when a refresh fails with staged edits", async () => {
  const state = notificationsConfig([]);
  render(
    <SettingsScreen
      client={fakeAppClient(state)}
      capabilities={CAPABILITIES}
      folder={null}
      onClose={() => undefined}
      threadId={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Interaction" }));
  fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
  await screen.findByRole("combobox", { name: "Error Notification" });
  fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
    target: { value: "off" },
  });
  await waitFor(() => expect(state.listeners?.size).toBeGreaterThan(0));
  state.failingReads = 100;
  const entry = state.entries[0];
  if (entry === undefined) throw new Error("Missing notification entry");
  for (const listener of state.listeners ?? []) {
    listener({
      key: entry.key,
      layer: "global",
      folder: null,
      revision: state.revision,
      entry,
    });
  }
  expect(await screen.findByText("Could not refresh settings")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("shows the save action's message when the post-save reload also fails", async () => {
  const state = notificationsConfig([]);
  state.writeFailure = new Error("The storage rejected the save.");
  render(
    <SettingsScreen
      client={fakeAppClient(state)}
      capabilities={CAPABILITIES}
      folder={null}
      onClose={() => undefined}
      threadId={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Interaction" }));
  fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
  await screen.findByRole("combobox", { name: "Error Notification" });
  fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
    target: { value: "off" },
  });
  state.failingReads = 1;
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The storage rejected the save.");
  expect(alert.textContent).not.toContain("The settings file could not be read.");
});

test("recovers the real screen after its first generic settings read fails", async () => {
  const state = notificationsConfig([]);
  state.failingReads = 100;
  render(
    <SettingsScreen
      client={fakeAppClient(state)}
      capabilities={CAPABILITIES}
      folder={null}
      onClose={() => undefined}
      threadId={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Interaction" }));
  fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
  expect(await screen.findByText("Could not load settings")).toBeTruthy();
  state.failingReads = 0;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("combobox", { name: "Error Notification" })).toBeTruthy();
});

describe("the generic settings panel after a save omp refuses in part", () => {
  test("names the setting omp did not save, marks its row, and offers neither Retry nor Applied", async () => {
    const state = notificationsConfig(["error.notify"]);
    render(
      <SettingsScreen
        client={fakeAppClient(state)}
        capabilities={CAPABILITIES}
        folder={null}
        onClose={() => undefined}
        threadId={null}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Interaction" }));
    fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
    await screen.findByRole("combobox", { name: "Error Notification" });

    fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
      target: { value: "off" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Error Notification" }), {
      target: { value: "off" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Not saved: Error Notification.")).toBeTruthy();
    expect(screen.getByText(REFUSAL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("Applied")).toBeNull();
    // Only the row whose setting was not saved carries the mark.
    expect(screen.getAllByText("Not saved", { exact: true })).toHaveLength(1);
    expect(
      screen.getByRole("combobox", { name: "Error Notification" }).parentElement?.textContent,
    ).toContain("Not saved");
    expect(
      screen.getByRole("combobox", { name: "Completion Notification" }).parentElement?.textContent,
    ).not.toContain("Not saved");
    // The refused edit stays staged, so Save changes can write it again.
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(state.writes).toEqual(["completion.notify"]);
  });

  test("a reload that fails after the write, with nothing left unsaved, still offers Retry", async () => {
    const state = notificationsConfig([]);
    render(
      <SettingsScreen
        client={fakeAppClient(state)}
        capabilities={CAPABILITIES}
        folder={null}
        onClose={() => undefined}
        threadId={null}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Interaction" }));
    fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
    await screen.findByRole("combobox", { name: "Error Notification" });

    // The reload after the write, and the reload that follows it, both fail.
    state.failingReads = 2;
    fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
      target: { value: "off" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/Not saved/)).toBeNull();
    expect(state.writes).toEqual(["completion.notify"]);
  });
});

describe("the generic settings panel after a save the environment overrides", () => {
  test("names the variable that overrides the saved setting, and does not say Applied", async () => {
    const state = notificationsConfig([]);
    state.environmentKeys = { "completion.notify": "PI_NOTIFY_COMPLETION" };
    render(
      <SettingsScreen
        client={fakeAppClient(state)}
        capabilities={CAPABILITIES}
        folder={null}
        onClose={() => undefined}
        threadId={null}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Interaction" }));
    fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
    await screen.findByRole("combobox", { name: "Error Notification" });

    fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
      target: { value: "off" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const notice =
      "Saved, but omp still uses the environment variable PI_NOTIFY_COMPLETION until it is removed.";
    expect(await screen.findByText(notice)).toBeTruthy();
    expect(screen.queryByText("Applied")).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
      target: { value: "on" },
    });
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(notice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(notice)).toBeNull();
  });
});

describe("the generic settings panel after a save omp refuses because the setting changed elsewhere", () => {
  /** Stages a change to Completion Notification, then has another writer change it, so omp refuses the save. */
  async function refusedSave(): Promise<FakeConfig> {
    const state = notificationsConfig([]);
    render(
      <SettingsScreen
        client={fakeAppClient(state)}
        capabilities={CAPABILITIES}
        folder={null}
        onClose={() => undefined}
        threadId={null}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Interaction" }));
    fireEvent.click(await screen.findByRole("option", { name: "Notifications" }));
    await screen.findByRole("combobox", { name: "Error Notification" });

    fireEvent.change(screen.getByRole("combobox", { name: "Completion Notification" }), {
      target: { value: "off" },
    });
    state.revision = "revision-elsewhere";
    state.entries = state.entries.map((entry) =>
      entry.key === "completion.notify" ? { ...entry, value: "off" } : entry,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Completion Notification: Off · Source: Saved for all projects",
    );
    return state;
  }

  test("offers only Reload latest and Keep my edits in the shared conflict banner", async () => {
    const state = await refusedSave();
    expect(screen.getByRole("button", { name: "Reload latest" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Settings changed elsewhere");
    expect(screen.queryByText("The settings changed elsewhere.")).toBeNull();
    expect(state.writes).toEqual([]);
  });

  test("names the conflict once: the card's heading, with no status pill above it", async () => {
    await refusedSave();
    expect(screen.getAllByText("Settings changed elsewhere")).toHaveLength(1);
  });

  test("Keep my edits clears the refusal, and the next save writes the edit", async () => {
    const state = await refusedSave();
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(state.writes).toEqual(["completion.notify"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("Reload latest drops the edit and clears the refusal", async () => {
    const state = await refusedSave();
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep my edits" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(state.writes).toEqual([]);
  });
});
