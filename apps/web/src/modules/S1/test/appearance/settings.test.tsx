import type { ConfigEntry, JsonValue } from "@omp-app/contracts";
import { AppFailure, ConfigWriteArgs } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AppearanceSettingsView, useAppearanceSettingsController } from "../../../S1/settings";
import type { ConfigChangeSource, ConfigStoreClient } from "../../../S1/settings-kit";
import { APP_THEME_PREVIEW_NOTE } from "../../appearance/descriptors";

type FakeConfig = {
  entries: ConfigEntry[];
  revision: string;
  writes: ConfigWriteArgs[];
  failNextList: boolean;
};

const DEFAULT_ENTRIES: readonly ConfigEntry[] = [
  { key: "theme.dark", secret: false, value: "titanium", source: "default", overrides: [] },
  { key: "theme.light", secret: false, value: "light", source: "default", overrides: [] },
  { key: "symbolPreset", secret: false, value: "unicode", source: "default", overrides: [] },
  { key: "colorBlindMode", secret: false, value: false, source: "default", overrides: [] },
  { key: "terminal.showImages", secret: false, value: true, source: "default", overrides: [] },
  { key: "images.autoResize", secret: false, value: true, source: "default", overrides: [] },
  { key: "images.blockImages", secret: false, value: false, source: "default", overrides: [] },
];

const changes: ConfigChangeSource = { subscribe: () => () => {} };

afterEach(() => cleanup());

function fakeClient(state: FakeConfig): ConfigStoreClient {
  return {
    async read({ key }) {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry) {
        throw new AppFailure({
          code: "not_found",
          message: "Configuration key was not found.",
          retryable: false,
        });
      }
      return entry;
    },
    async list() {
      if (state.failNextList) {
        state.failNextList = false;
        throw new Error("temporary ConfigStore failure");
      }
      return { entries: state.entries, revision: state.revision };
    },

    async write(input) {
      const write = ConfigWriteArgs.parse(input);
      state.writes.push(write);
      if (write.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Configuration changed elsewhere.",
          retryable: true,
        });
      }
      if (write.value.secret) throw new Error("The appearance fixture does not accept secrets.");
      const previousRevision = state.revision;
      state.revision = `revision-${state.writes.length + 1}`;
      const entry: ConfigEntry = {
        key: write.key,
        secret: false,
        value: write.value.value as JsonValue,
        source: write.layer,
        overrides: ["default"],
      };
      state.entries = state.entries.map((candidate) =>
        candidate.key === write.key ? entry : candidate,
      );
      return {
        key: write.key,
        layer: write.layer,
        folder: write.folder,
        previousRevision,
        revision: state.revision,
        entry,
      };
    },
  };
}

function AppearanceSettingsHarness({ client }: { readonly client: ConfigStoreClient }) {
  const { model, actions } = useAppearanceSettingsController({
    client,
    changes,
    folder: null,
    layer: "global",
  });
  return <AppearanceSettingsView model={model} actions={actions} onClose={() => undefined} />;
}

describe("S1.3 appearance settings surface", () => {
  test("loads settings and commits a runtime-named theme through ConfigStore", async () => {
    const state: FakeConfig = {
      entries: [...DEFAULT_ENTRIES],
      revision: "revision-1",
      writes: [],
      failNextList: false,
    };

    render(<AppearanceSettingsHarness client={fakeClient(state)} />);

    await screen.findByRole("button", { name: "Choose dark theme…" });
    fireEvent.click(screen.getByRole("button", { name: "Choose dark theme…" }));
    fireEvent.change(screen.getByLabelText("OMP theme name"), {
      target: { value: "custom-dark" },
    });
    expect(screen.getByText(APP_THEME_PREVIEW_NOTE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this theme name" }));

    const save = await screen.findByRole("button", { name: "Save changes" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({
      key: "theme.dark",
      layer: "global",
      value: { secret: false, value: "custom-dark" },
    });
    const savedTheme = state.entries.find((entry) => entry.key === "theme.dark");
    if (!savedTheme || savedTheme.secret) throw new Error("Expected a saved theme value.");
    expect(savedTheme.value).toBe("custom-dark");
  });

  test("surfaces a ConfigStore read failure and recovers through Retry", async () => {
    const state: FakeConfig = {
      entries: [...DEFAULT_ENTRIES],
      revision: "revision-1",
      writes: [],
      failNextList: true,
    };
    render(<AppearanceSettingsHarness client={fakeClient(state)} />);

    expect(await screen.findByText("temporary ConfigStore failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Choose dark theme…" })).toBeTruthy();
    expect(screen.queryByText("temporary ConfigStore failure")).toBeNull();
  });

  test("previews inline-image choice and restores the committed preview on cancel", async () => {
    const state: FakeConfig = {
      entries: [...DEFAULT_ENTRIES],
      revision: "revision-1",
      writes: [],
      failNextList: false,
    };
    render(<AppearanceSettingsHarness client={fakeClient(state)} />);

    await screen.findByRole("tab", { name: "Images" });
    fireEvent.click(screen.getByRole("tab", { name: "Images" }));
    fireEvent.click(screen.getByRole("button", { name: "Show images selector…" }));
    fireEvent.focus(screen.getByRole("button", { name: "No" }));
    expect(screen.getByText("Image placeholder")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("img", { name: "Inline image preview" })).toBeTruthy();
    expect(state.writes).toHaveLength(0);
  });
});
