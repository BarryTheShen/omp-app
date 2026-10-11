import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type ConfigEntry,
  type ConfigWriteResult,
  JsonValue,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  /** Environment variables that supply a written key's value, by key: the write then reports that source. */
  environmentKeys?: Readonly<Record<string, string>>;
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
      if (args.value.secret) throw new Error("The notification settings are not secrets.");
      state.writes.push(args.key);
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
      onEvent: () => () => undefined,
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
    ],
    refused: new Set(refused),
    failingReads: 0,
    writes: [],
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

    expect(
      await screen.findByText(
        "Saved, but omp still uses the environment variable PI_NOTIFY_COMPLETION until it is removed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Applied")).toBeNull();
  });
});
