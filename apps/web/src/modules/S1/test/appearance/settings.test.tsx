import type { ConfigEntry, JsonValue } from "@omp-app/contracts";
import { AppFailure, ConfigWriteArgs } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AppearanceSettingsView, useAppearanceSettingsController } from "../../../S1/settings";
import type {
  ConfigChangeSource,
  ConfigStoreClient,
  SettingsSectionDescriptor,
} from "../../../S1/settings-kit";
import { COMPOSER_SETTINGS_SECTION } from "../../appearance";
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

function AppearanceSettingsHarness({
  client,
  appearanceSections,
  initialSectionId,
  previewPalette,
  applyThemePreview,
}: {
  readonly client: ConfigStoreClient;
  readonly appearanceSections?: readonly SettingsSectionDescriptor[];
  readonly initialSectionId?: string;
  readonly previewPalette?: "light" | "dark";
  readonly applyThemePreview?: boolean;
}) {
  const { model, actions } = useAppearanceSettingsController({
    appearanceSections,
    applyThemePreview,
    client,
    changes,
    folder: null,
    initialSectionId,
    layer: "global",
    previewPalette,
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
    fireEvent.change(screen.getByLabelText("omp theme name"), {
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
  test("supports a registry-filtered embedded surface without changing the app palette", async () => {
    const state: FakeConfig = {
      entries: [...DEFAULT_ENTRIES],
      revision: "revision-1",
      writes: [],
      failNextList: false,
    };
    const wasDark = document.documentElement.classList.contains("dark");
    render(
      <AppearanceSettingsHarness
        appearanceSections={[COMPOSER_SETTINGS_SECTION]}
        applyThemePreview={false}
        client={fakeClient(state)}
        initialSectionId={COMPOSER_SETTINGS_SECTION.id}
        previewPalette="dark"
      />,
    );

    expect(await screen.findByRole("tab", { name: "Composer" })).toBeTruthy();
    expect(screen.queryByText("Dark Theme")).toBeNull();
    expect(screen.getByLabelText("Appearance preview").getAttribute("data-palette")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(wasDark);
  });

  test("the section tabs move focus and selection with the arrow, Home and End keys", async () => {
    const state: FakeConfig = {
      entries: [...DEFAULT_ENTRIES],
      revision: "revision-1",
      writes: [],
      failNextList: false,
    };
    render(<AppearanceSettingsHarness client={fakeClient(state)} />);

    await screen.findByRole("tab", { name: "Images" });
    const tabs = screen.getAllByRole("tab");
    const last = tabs.length - 1;
    expect(last).toBeGreaterThan(1);
    const tabAt = (index: number): HTMLElement => {
      const tab = tabs[index];
      if (!tab) throw new Error(`No tab at ${index}.`);
      return tab;
    };
    tabAt(0).focus();
    fireEvent.keyDown(tabAt(0), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabAt(1));
    expect(tabAt(1).getAttribute("aria-selected")).toBe("true");
    expect(tabAt(0).tabIndex).toBe(-1);
    fireEvent.keyDown(tabAt(1), { key: "End" });
    expect(document.activeElement).toBe(tabAt(last));
    fireEvent.keyDown(tabAt(last), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabAt(0));
    fireEvent.keyDown(tabAt(0), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabAt(last));
    fireEvent.keyDown(tabAt(last), { key: "Home" });
    expect(document.activeElement).toBe(tabAt(0));
    expect(tabAt(0).getAttribute("aria-selected")).toBe("true");
  });

  test("says that these settings change omp's terminal only", async () => {
    const state: FakeConfig = {
      entries: [...DEFAULT_ENTRIES],
      revision: "revision-1",
      writes: [],
      failNextList: false,
    };
    render(<AppearanceSettingsHarness client={fakeClient(state)} />);

    expect(
      await screen.findByText(
        "These settings change omp's terminal only. This app does not use them.",
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Terminal preview" })).toBeTruthy();
  });
});
