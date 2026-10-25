import type { ConfigEntry, JsonValue } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type {
  ConfigSnapshot,
  ScalarSettingControl,
  SettingControl,
  SettingsSectionDescriptor,
} from "../../../S1/settings-kit";
import {
  COMPOSER_SETTINGS_SECTION,
  S1_APPEARANCE_SECTIONS,
  STATUS_LINE_SETTINGS_SECTION,
  THEME_SETTINGS_SECTION,
} from "../../appearance";

// omp v18.12.6 defaults: modes/settings.ts:59-333 and 361-755; task/settings.ts:536-546; utils/title-settings.ts:12-66.
const DEFAULT_VALUES: Readonly<Record<string, JsonValue>> = {
  "theme.dark": "titanium",
  "theme.light": "light",
  symbolPreset: "unicode",
  colorBlindMode: false,
  "composer.shape": "band",
  "composer.tokenRate": false,
  "statusLine.preset": "default",
  "statusLine.separator": "powerline-thin",
  "statusLine.contextLine": "embedded",
  "statusLine.sessionAccent": true,
  "statusLine.transparent": false,
  "statusLine.compactThinkingLevel": true,
  "statusLine.showHookStatus": true,
  "tui.resizeScrollback": "rebuild",
  "tui.completeScrollback": false,
  "terminal.showProgress": false,
  "terminal.programStatus": true,
  "tui.textSizing": false,
  "tui.renderMermaid": true,
  "title.icons": "nf+emoji",
  "tui.renderSvg": true,
  "tui.autoGraph": "always",
  "tui.reactions": true,
  "tui.codexResetFireworks": false,
  "tui.titleState": true,
  "tui.titleSpinner": "braille",
  "tui.hyperlinks": "auto",
  "tui.mouse": false,
  "tui.tight": false,
  "display.shimmer": "classic",
  "display.pinnedAgents": "collapsed",
  "display.subagentLivePreview": false,
  "display.smoothStreaming": true,
  "display.hideToolActivity": false,
  "display.showTokenUsage": false,
  "display.showTurnTime": false,
  "display.cacheMissMarker": false,
  "display.collapseCompacted": true,
  showHardwareCursor: true,
  "tui.imeSafeCursor": false,
  "task.showResolvedModelBadge": false,
  "terminal.showImages": true,
  "images.autoResize": true,
  "images.blockImages": false,
};

const EXPECTED_KEYS = {
  theme: ["theme.dark", "theme.light", "symbolPreset", "colorBlindMode"],
  composer: ["composer.shape", "composer.tokenRate"],
  statusLine: [
    "statusLine.preset",
    "statusLine.separator",
    "statusLine.contextLine",
    "statusLine.sessionAccent",
    "statusLine.transparent",
    "statusLine.compactThinkingLevel",
    "statusLine.showHookStatus",
  ],
  display: [
    "tui.resizeScrollback",
    "tui.completeScrollback",
    "terminal.showProgress",
    "terminal.programStatus",
    "tui.textSizing",
    "tui.renderMermaid",
    "title.icons",
    "tui.renderSvg",
    "tui.autoGraph",
    "tui.reactions",
    "tui.codexResetFireworks",
    "tui.titleState",
    "tui.titleSpinner",
    "tui.hyperlinks",
    "tui.mouse",
    "tui.tight",
    "display.shimmer",
    "display.pinnedAgents",
    "display.subagentLivePreview",
    "display.smoothStreaming",
    "display.hideToolActivity",
    "display.showTokenUsage",
    "display.showTurnTime",
    "display.cacheMissMarker",
    "display.collapseCompacted",
    "showHardwareCursor",
    "tui.imeSafeCursor",
    "task.showResolvedModelBadge",
  ],
  images: ["terminal.showImages", "images.autoResize", "images.blockImages"],
} as const;

const EXPECTED_KINDS: Readonly<Record<string, SettingControl["kind"]>> = {
  "theme.dark": "text",
  "theme.light": "text",
  symbolPreset: "enum",
  colorBlindMode: "boolean",
  "composer.shape": "text",
  "composer.tokenRate": "boolean",
  "statusLine.preset": "enum",
  "statusLine.separator": "enum",
  "statusLine.contextLine": "enum",
  "statusLine.sessionAccent": "boolean",
  "statusLine.transparent": "boolean",
  "statusLine.compactThinkingLevel": "boolean",
  "statusLine.showHookStatus": "boolean",
  "tui.resizeScrollback": "enum",
  "tui.completeScrollback": "boolean",
  "terminal.showProgress": "boolean",
  "terminal.programStatus": "boolean",
  "tui.textSizing": "boolean",
  "tui.renderMermaid": "boolean",
  "title.icons": "enum",
  "tui.renderSvg": "boolean",
  "tui.autoGraph": "enum",
  "tui.reactions": "boolean",
  "tui.codexResetFireworks": "boolean",
  "tui.titleState": "boolean",
  "tui.titleSpinner": "enum",
  "tui.hyperlinks": "enum",
  "tui.mouse": "boolean",
  "tui.tight": "boolean",
  "display.shimmer": "enum",
  "display.pinnedAgents": "enum",
  "display.subagentLivePreview": "boolean",
  "display.smoothStreaming": "boolean",
  "display.hideToolActivity": "boolean",
  "display.showTokenUsage": "boolean",
  "display.showTurnTime": "boolean",
  "display.cacheMissMarker": "boolean",
  "display.collapseCompacted": "boolean",
  showHardwareCursor: "boolean",
  "tui.imeSafeCursor": "boolean",
  "task.showResolvedModelBadge": "boolean",
  "terminal.showImages": "boolean",
  "images.autoResize": "boolean",
  "images.blockImages": "boolean",
};

function defaultSnapshot(descriptor: SettingsSectionDescriptor): ConfigSnapshot {
  const entries: ConfigEntry[] = descriptor.controls.map((setting) => {
    const value = DEFAULT_VALUES[setting.key];
    if (value === undefined) throw new Error(`Missing omp v18.12.6 default for ${setting.key}.`);
    return { key: setting.key, secret: false, value, source: "default", overrides: [] };
  });
  return { folder: null, revision: "revision-1", entries };
}

describe("S1.3 appearance sections", () => {
  test("claims all five S1 appearance rows and exactly the registered setting keys", () => {
    const keys = S1_APPEARANCE_SECTIONS.flatMap((descriptor) =>
      descriptor.controls.map((setting) => setting.key),
    );
    const expected = Object.values(EXPECTED_KEYS).flat();

    expect(S1_APPEARANCE_SECTIONS.map((descriptor) => descriptor.section)).toEqual([
      "appearance/Theme",
      "appearance/Composer",
      "appearance/Status Line",
      "appearance/Display",
      "appearance/Images",
    ]);
    expect(keys).toHaveLength(44);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...expected].sort());
    expect(S1_APPEARANCE_SECTIONS.flatMap((descriptor) => descriptor.inventory)).toEqual([
      "S1.appearance-theme",
      "S1.appearance-composer",
      "S1.appearance-status-line",
      "S1.appearance-display",
      "S1.appearance-images",
    ]);
    expect(keys).not.toContain("plugins.enabled");
  });

  test("validates every effective source default and preserves its apply boundary", () => {
    const sharedAppearanceKeys = new Set([
      "theme.dark",
      "theme.light",
      "images.autoResize",
      "images.blockImages",
      "tui.reactions",
      "title.icons",
    ]);
    for (const descriptor of S1_APPEARANCE_SECTIONS) {
      const snapshot = defaultSnapshot(descriptor);
      expect(descriptor.requires).toContain("host.config");
      for (const setting of descriptor.controls) {
        expect(setting.kind).toBe(EXPECTED_KINDS[setting.key]);
        expect(setting.secret).toBe(false);
        expect(setting.apply).toBe("live");
        if (sharedAppearanceKeys.has(setting.key)) {
          expect(setting.description ?? "").not.toMatch(/^Terminal only\./);
        } else {
          expect(setting.description).toMatch(/^Terminal only\. /);
        }
        const value = DEFAULT_VALUES[setting.key];
        if (value === undefined)
          throw new Error(`Missing omp v18.12.6 default fixture for ${setting.key}.`);
        expect(setting.validate({ secret: false, value }, snapshot)).toEqual({ valid: true });
        expect(snapshot.entries.find((entry) => entry.key === setting.key)).toMatchObject({
          value,
          source: "default",
          overrides: [],
        });
      }
    }
  });

  test("keeps dynamic OMP names editable without app previews", () => {
    const snapshot = defaultSnapshot(THEME_SETTINGS_SECTION);
    const theme = THEME_SETTINGS_SECTION.controls.find((setting) => setting.key === "theme.dark");
    const shape = COMPOSER_SETTINGS_SECTION.controls.find(
      (setting) => setting.key === "composer.shape",
    );
    if (!theme || !shape) throw new Error("Missing runtime-valued appearance controls.");

    expect(theme.validate({ secret: false, value: "custom-omp-theme" }, snapshot)).toEqual({
      valid: true,
    });
    expect(
      shape.validate(
        { secret: false, value: "extension-shape" },
        defaultSnapshot(COMPOSER_SETTINGS_SECTION),
      ),
    ).toEqual({ valid: true });
    expect(theme.preview).toBeUndefined();
    expect(shape.preview).toBeUndefined();
    expect(theme.description).toBe("Theme used when the terminal has a dark background");
    expect(shape.description).toBe(
      "Terminal only. Visual layout of the input editor and status line",
    );
    const themeEntry = snapshot.entries.find((entry) => entry.key === "theme.dark");
    if (!themeEntry || themeEntry.secret) throw new Error("Missing effective theme entry.");
    expect(themeEntry.value).toBe("titanium");
  });

  test("uses the omp enum values for status, display and symbols", () => {
    const snapshot = defaultSnapshot(STATUS_LINE_SETTINGS_SECTION);
    const expected = {
      "statusLine.preset": ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"],
      "statusLine.separator": [
        "powerline",
        "powerline-thin",
        "slash",
        "pipe",
        "block",
        "none",
        "ascii",
      ],
      "statusLine.contextLine": ["off", "percentage", "annotated", "embedded"],
    } as const;
    for (const [key, values] of Object.entries(expected)) {
      const setting = enumControl(key);
      expect(setting.options?.map((option) => option.value)).toEqual(values);
    }
    expect(enumControl("tui.resizeScrollback").options?.map((option) => option.value)).toEqual([
      "append",
      "rebuild",
      "preserve",
    ]);
    expect(enumControl("symbolPreset").options?.map((option) => option.value)).toEqual([
      "unicode",
      "nerd",
      "ascii",
    ]);
    expect(snapshot.entries).toHaveLength(7);
  });
  test("keeps Title Icons live and relevant to app-generated session titles", () => {
    const icons = enumControl("title.icons");
    expect(icons.apply).toBe("live");
    expect(icons.description).not.toMatch(/Terminal only/);
    expect(icons.options?.map((option) => option.label)).toEqual([
      "Nerd Font + Emoji",
      "Emoji",
      "Boring",
    ]);
  });
});

function enumControl(key: string): ScalarSettingControl & { readonly kind: "enum" } {
  const found = control(key);
  if (found.kind !== "enum") throw new Error(`Appearance setting ${key} is not an enum.`);
  return found as ScalarSettingControl & { readonly kind: "enum" };
}

function control(key: string): SettingControl {
  const found = S1_APPEARANCE_SECTIONS.flatMap((descriptor) => descriptor.controls).find(
    (setting) => setting.key === key,
  );
  if (!found) throw new Error(`Missing appearance setting ${key}.`);
  return found;
}
