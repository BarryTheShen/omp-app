import type { CapabilityKey, JsonValue } from "@omp-app/contracts";
import type {
  ScalarSettingControl,
  SettingControl,
  SettingOption,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../settings-kit";
import { settingOptions } from "../settings-kit";

const HOST_CONFIG = ["host.config"] as const satisfies readonly CapabilityKey[];

/**
 * omp v18.6.1 appearance registrations: `packages/coding-agent/src/modes/settings.ts:58-331`
 * (Theme, Composer, Status Line, Images), `:360-685` (Display), and
 * `packages/coding-agent/src/task/settings.ts:442-447` (the resolved-model badge).
 * Theme/composer choices are runtime-provided by omp; the app accepts any setting name and previews
 * only the palettes and shapes bundled here. ConfigStore supplies effective defaults and provenance.
 */
export const APP_THEME_PREVIEW_NOTE =
  "The app uses omp's default titanium and light colors; other omp themes apply in the terminal.";
export const APP_COMPOSER_PREVIEW_NOTE =
  "The app can preview its bundled composer styles; extension composer shapes apply in omp's terminal.";

const STATUS_LINE_PRESETS = [
  "default",
  "minimal",
  "compact",
  "full",
  "nerd",
  "ascii",
  "custom",
] as const;
const STATUS_LINE_SEPARATORS = [
  "powerline",
  "powerline-thin",
  "slash",
  "pipe",
  "block",
  "none",
  "ascii",
] as const;
const CONTEXT_LINE_MODES = ["off", "percentage", "annotated", "embedded"] as const;
const TITLE_SPINNERS = ["braille", "pulse", "dots", "line"] as const;
const HYPERLINK_MODES = ["off", "auto", "always"] as const;
const SHIMMER_MODES = ["classic", "kitt", "disabled"] as const;
const PINNED_AGENT_MODES = ["off", "collapsed", "full"] as const;
const RESIZE_SCROLLBACK_MODES = ["append", "rebuild", "preserve"] as const;

function plain(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function invalid(code: string, message: string): ValidationResult {
  return { valid: false, code, message };
}

function validateBoolean(value: SettingValue): ValidationResult {
  return typeof plain(value) === "boolean"
    ? { valid: true }
    : invalid("boolean", "Choose true or false.");
}

function validateText(value: SettingValue): ValidationResult {
  const candidate = plain(value);
  return typeof candidate === "string" && candidate.trim().length > 0 && !candidate.includes("\0")
    ? { valid: true }
    : invalid("text", "Enter a non-empty setting name.");
}

function validateEnum(values: readonly string[]) {
  return (value: SettingValue): ValidationResult => {
    const candidate = plain(value);
    return typeof candidate === "string" && values.some((option) => option === candidate)
      ? { valid: true }
      : invalid("enum", `Choose one of: ${values.join(", ")}.`);
  };
}

function previewValue(key: string): ScalarSettingControl["preview"] {
  return (value) => (value.secret ? null : { key, value: value.value });
}

function control(
  key: SettingControl["key"],
  label: string,
  kind: ScalarSettingControl["kind"],
  validate: ScalarSettingControl["validate"],
  options?: readonly SettingOption[],
  description?: string,
  preview?: ScalarSettingControl["preview"],
): ScalarSettingControl {
  return {
    key,
    label,
    kind,
    secret: false,
    validate,
    apply: "live",
    ...(options === undefined ? {} : { options }),
    ...(description === undefined ? {} : { description }),
    ...(preview === undefined ? {} : { preview }),
  };
}

function booleanControl(
  key: string,
  label: string,
  description?: string,
  preview?: ScalarSettingControl["preview"],
): ScalarSettingControl {
  return control(key, label, "boolean", validateBoolean, undefined, description, preview);
}

function enumControl(
  key: string,
  label: string,
  values: readonly string[],
  labels: Readonly<Record<string, string>> = {},
  description?: string,
  preview?: ScalarSettingControl["preview"],
): ScalarSettingControl {
  return control(
    key,
    label,
    "enum",
    validateEnum(values),
    settingOptions(values, labels),
    description,
    preview,
  );
}

function textControl(
  key: string,
  label: string,
  description: string,
  preview?: ScalarSettingControl["preview"],
): ScalarSettingControl {
  return control(key, label, "text", validateText, undefined, description, preview);
}

function section(
  id: SettingsSectionDescriptor["id"],
  sectionName: SettingsSectionDescriptor["section"],
  title: string,
  inventory: SettingsSectionDescriptor["inventory"],
  controls: readonly SettingControl[],
): SettingsSectionDescriptor {
  return { id, section: sectionName, title, inventory, controls, requires: [...HOST_CONFIG] };
}

export const THEME_SETTINGS_SECTION = section(
  "S1.appearanceTheme",
  "appearance/Theme",
  "Theme",
  ["S1.appearance-theme"],
  [
    textControl(
      "theme.dark",
      "Dark Theme",
      "The omp theme for dark mode in the terminal. Any installed omp theme name can be saved.",
      previewValue("theme.dark"),
    ),
    textControl(
      "theme.light",
      "Light Theme",
      "The omp theme for light mode in the terminal. Any installed omp theme name can be saved.",
      previewValue("theme.light"),
    ),
    enumControl("symbolPreset", "Symbol Preset", ["unicode", "nerd", "ascii"], {
      unicode: "Unicode",
      nerd: "Nerd Font",
      ascii: "ASCII",
    }),
    booleanControl("colorBlindMode", "Color-Blind Mode"),
  ],
);

export const COMPOSER_SETTINGS_SECTION = section(
  "S1.appearanceComposer",
  "appearance/Composer",
  "Composer",
  ["S1.appearance-composer"],
  [
    textControl(
      "composer.shape",
      "Composer Shape",
      "The omp composer shape. Built-in shapes can be previewed; shapes from extensions can still be set by name.",
      previewValue("composer.shape"),
    ),
    booleanControl("composer.tokenRate", "Generation Rate"),
  ],
);

export const STATUS_LINE_SETTINGS_SECTION = section(
  "S1.appearanceStatusLine",
  "appearance/Status Line",
  "Status Line",
  ["S1.appearance-status-line"],
  [
    enumControl(
      "statusLine.preset",
      "Status Line Preset",
      STATUS_LINE_PRESETS,
      {
        default: "Default",
        minimal: "Minimal",
        compact: "Compact",
        full: "Full",
        nerd: "Nerd",
        ascii: "ASCII",
        custom: "Custom",
      },
      undefined,
      previewValue("statusLine.preset"),
    ),
    enumControl(
      "statusLine.separator",
      "Status Line Separator",
      STATUS_LINE_SEPARATORS,
      {
        powerline: "Powerline",
        "powerline-thin": "Thin chevron",
        slash: "Slash",
        pipe: "Pipe",
        block: "Block",
        none: "None",
        ascii: "ASCII",
      },
      undefined,
      previewValue("statusLine.separator"),
    ),
    enumControl(
      "statusLine.contextLine",
      "Context-Reactive Line",
      CONTEXT_LINE_MODES,
      {
        off: "Off",
        percentage: "Percentage",
        annotated: "Annotated",
        embedded: "Embedded",
      },
      undefined,
      previewValue("statusLine.contextLine"),
    ),
    booleanControl("statusLine.sessionAccent", "Session Accent"),
    booleanControl("statusLine.transparent", "Transparent Status Line"),
    booleanControl("statusLine.compactThinkingLevel", "Compact Thinking Level"),
    booleanControl("statusLine.showHookStatus", "Show Hook Status"),
  ],
);

export const DISPLAY_SETTINGS_SECTION = section(
  "S1.appearanceDisplay",
  "appearance/Display",
  "Display",
  ["S1.appearance-display"],
  [
    enumControl("tui.resizeScrollback", "Resize Scrollback", RESIZE_SCROLLBACK_MODES, {
      append: "Append",
      rebuild: "Rebuild",
      preserve: "Preserve",
    }),
    booleanControl("terminal.showProgress", "Native Terminal Progress"),
    booleanControl("tui.textSizing", "Large Headings (Kitty)"),
    booleanControl("tui.renderMermaid", "Render Mermaid Diagrams"),
    booleanControl("tui.reactions", "Agent Reactions"),
    booleanControl("tui.codexResetFireworks", "Codex Reset Fireworks"),
    booleanControl("tui.titleState", "Terminal Title Run State"),
    enumControl("tui.titleSpinner", "Terminal Title Spinner", TITLE_SPINNERS, {
      braille: "Braille",
      pulse: "Pulse",
      dots: "Dots",
      line: "Line",
    }),
    enumControl("tui.hyperlinks", "Terminal Hyperlinks", HYPERLINK_MODES, {
      off: "Off",
      auto: "Auto",
      always: "Always",
    }),
    booleanControl("tui.mouse", "Mouse Click-to-Focus"),
    booleanControl("tui.tight", "Tight Layout"),
    enumControl("display.shimmer", "Shimmer", SHIMMER_MODES, {
      classic: "Classic",
      kitt: "KITT Scanner",
      disabled: "Disabled",
    }),
    enumControl("display.pinnedAgents", "Pinned Agents", PINNED_AGENT_MODES, {
      off: "Off",
      collapsed: "Collapsed",
      full: "Full",
    }),
    booleanControl("display.subagentLivePreview", "Subagent Live Preview"),
    booleanControl(
      "display.smoothStreaming",
      "Smooth Streaming",
      undefined,
      previewValue("display.smoothStreaming"),
    ),
    booleanControl(
      "display.hideToolActivity",
      "Hide Tool Activity",
      undefined,
      previewValue("display.hideToolActivity"),
    ),
    booleanControl(
      "display.showTokenUsage",
      "Show Token Usage",
      undefined,
      previewValue("display.showTokenUsage"),
    ),
    booleanControl(
      "display.showTurnTime",
      "Show Turn Time",
      undefined,
      previewValue("display.showTurnTime"),
    ),
    booleanControl(
      "display.cacheMissMarker",
      "Cache Miss Marker",
      undefined,
      previewValue("display.cacheMissMarker"),
    ),
    booleanControl(
      "display.collapseCompacted",
      "Collapse Compacted History",
      undefined,
      previewValue("display.collapseCompacted"),
    ),
    booleanControl("showHardwareCursor", "Show Hardware Cursor"),
    booleanControl("tui.imeSafeCursor", "IME-Safe Prompt Layout"),
    booleanControl("task.showResolvedModelBadge", "Show Resolved Model Badge"),
  ],
);

export const IMAGES_SETTINGS_SECTION = section(
  "S1.appearanceImages",
  "appearance/Images",
  "Images",
  ["S1.appearance-images"],
  [
    booleanControl(
      "terminal.showImages",
      "Show Inline Images",
      "Show images inline or as placeholders in omp's terminal.",
      previewValue("terminal.showImages"),
    ),
    booleanControl("images.autoResize", "Auto-Resize Images"),
    booleanControl("images.blockImages", "Block Images"),
  ],
);

export const S1_APPEARANCE_SECTIONS: readonly SettingsSectionDescriptor[] = [
  THEME_SETTINGS_SECTION,
  COMPOSER_SETTINGS_SECTION,
  STATUS_LINE_SETTINGS_SECTION,
  DISPLAY_SETTINGS_SECTION,
  IMAGES_SETTINGS_SECTION,
];
