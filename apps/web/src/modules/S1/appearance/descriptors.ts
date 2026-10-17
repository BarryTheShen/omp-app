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
 * These settings affect omp's terminal; ConfigStore supplies effective defaults and provenance.
 */

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

const TERMINAL_ONLY = "Terminal only.";

function terminalDescription(description: string | undefined): string {
  return description === undefined ? TERMINAL_ONLY : `${TERMINAL_ONLY} ${description}`;
}

function control(
  key: SettingControl["key"],
  label: string,
  kind: ScalarSettingControl["kind"],
  validate: ScalarSettingControl["validate"],
  options?: readonly SettingOption[],
  description?: string,
): ScalarSettingControl {
  return {
    key,
    label,
    kind,
    secret: false,
    validate,
    apply: "live",
    ...(options === undefined ? {} : { options }),
    description: terminalDescription(description),
  };
}

function booleanControl(key: string, label: string, description?: string): ScalarSettingControl {
  return control(key, label, "boolean", validateBoolean, undefined, description);
}

function enumControl(
  key: string,
  label: string,
  values: readonly string[],
  labels: Readonly<Record<string, string>> = {},
  description?: string,
): ScalarSettingControl {
  return control(
    key,
    label,
    "enum",
    validateEnum(values),
    settingOptions(values, labels),
    description,
  );
}

function textControl(key: string, label: string, description: string): ScalarSettingControl {
  return control(key, label, "text", validateText, undefined, description);
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
    textControl("theme.dark", "Dark Theme", "Theme used when the terminal has a dark background"),
    textControl(
      "theme.light",
      "Light Theme",
      "Theme used when the terminal has a light background",
    ),
    enumControl(
      "symbolPreset",
      "Symbol Preset",
      ["unicode", "nerd", "ascii"],
      {
        unicode: "Unicode",
        nerd: "Nerd Font",
        ascii: "ASCII",
      },
      "Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)",
    ),
    booleanControl(
      "colorBlindMode",
      "Color-Blind Mode",
      "Use blue instead of green for diff additions",
    ),
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
      "Visual layout of the input editor and status line",
    ),
    booleanControl(
      "composer.tokenRate",
      "Generation Rate",
      "Show a live generation tok/s readout: on the working row next to the session title, or in the native composer bar right after the thinking level, where the last reading stays between turns. Estimated from streamed deltas and corrected by the provider's billed output count as each message completes.",
    ),
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
      "Pre-built status line configurations",
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
      "Style of separators between segments",
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
      "How the line between the left and right segments reflects context usage (box composer only)",
    ),
    booleanControl(
      "statusLine.sessionAccent",
      "Session Accent",
      "Use the session name color for the editor border and status line gap",
    ),
    booleanControl(
      "statusLine.transparent",
      "Transparent Status Line",
      "Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.",
    ),
    booleanControl(
      "statusLine.compactThinkingLevel",
      "Compact Thinking Level",
      "Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix; in Tern's composer, as the model chip's icon instead of a separate chip (click the icon to cycle it).",
    ),
    booleanControl(
      "statusLine.showHookStatus",
      "Show Hook Status",
      "Display hook status messages below the status line",
    ),
  ],
);

export const DISPLAY_SETTINGS_SECTION = section(
  "S1.appearanceDisplay",
  "appearance/Display",
  "Display",
  ["S1.appearance-display"],
  [
    enumControl(
      "tui.resizeScrollback",
      "Resize Scrollback",
      RESIZE_SCROLLBACK_MODES,
      {
        append: "Append",
        rebuild: "Rebuild",
        preserve: "Preserve",
      },
      "How a settled terminal resize refreshes transcript rows retained in terminal scrollback",
    ),
    booleanControl(
      "terminal.showProgress",
      "Native Terminal Progress",
      "Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running (always on in Tern)",
    ),
    booleanControl(
      "terminal.programStatus",
      "Program Status (OSC 7501)",
      "Report whether the agent is working, waiting on you, done, or failed over OSC 7501, for terminal tab indicators and agent inboxes",
    ),
    booleanControl(
      "tui.textSizing",
      "Large Headings (Kitty)",
      "Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.",
    ),
    booleanControl(
      "tui.renderMermaid",
      "Render Mermaid Diagrams",
      "Render Mermaid fenced code blocks as ASCII diagrams",
    ),
    booleanControl(
      "tui.renderSvg",
      "Render SVG Figures",
      "Invite the agent to draw diagrams and charts as SVG, rendered inline as images on terminals that show graphics",
    ),
    enumControl(
      "tui.autoGraph",
      "Auto-Graph Tables",
      ["smart", "always", "off"],
      {
        smart: "Smart",
        always: "Always",
        off: "Off",
      },
      "Draw a chart under numeric tables in the agent's answers, in your theme's colors, on terminals that show graphics",
    ),
    booleanControl(
      "tui.reactions",
      "Agent Reactions",
      "Invite the agent to react to your message with an emoji badge on its bubble",
    ),
    booleanControl(
      "tui.codexResetFireworks",
      "Codex Reset Fireworks",
      "Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until Escape",
    ),
    booleanControl(
      "tui.titleState",
      "Terminal Title Run State",
      "Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' under WSL), '>' when it's your turn, '!' when the agent is waiting on you",
    ),
    enumControl(
      "tui.titleSpinner",
      "Terminal Title Spinner",
      TITLE_SPINNERS,
      {
        braille: "Braille",
        pulse: "Pulse",
        dots: "Dots",
        line: "Line",
      },
      "Glyph set for the working-state spinner in the terminal title — braille sweep, filling moon, single-dot cycle, or ASCII-safe line",
    ),
    enumControl(
      "tui.hyperlinks",
      "Terminal Hyperlinks",
      HYPERLINK_MODES,
      {
        off: "Off",
        auto: "Auto",
        always: "Always",
      },
      "Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)",
    ),
    booleanControl(
      "tui.mouse",
      "Mouse Click-to-Focus",
      "Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes Shift+drag and wheel scroll becomes Shift+wheel while on",
    ),
    booleanControl(
      "tui.tight",
      "Tight Layout",
      "Remove the 1-character horizontal padding from the left and right of the terminal output",
    ),
    enumControl(
      "display.shimmer",
      "Shimmer",
      SHIMMER_MODES,
      {
        classic: "Classic",
        kitt: "KITT Scanner",
        disabled: "Disabled",
      },
      "Animation style for working/loading messages",
    ),
    enumControl(
      "display.pinnedAgents",
      "Pinned Agents",
      PINNED_AGENT_MODES,
      {
        off: "Off",
        collapsed: "Collapsed",
        full: "Full",
      },
      "Pinned live-agent jump list above the editor (off hides it; collapsed shows a few rows with an expander; full lists all)",
    ),
    booleanControl(
      "display.subagentLivePreview",
      "Subagent Live Preview",
      "Show each pinned subagent's current (or most recent) tool call beneath its row",
    ),
    booleanControl(
      "display.smoothStreaming",
      "Smooth Streaming",
      "Reveal assistant text and streamed tool input smoothly while chunks arrive",
    ),
    booleanControl(
      "display.hideToolActivity",
      "Hide Tool Activity",
      "Hide model-initiated tool calls and results from the transcript",
    ),
    booleanControl(
      "display.showTokenUsage",
      "Show Token Usage",
      "Show per-turn token usage on assistant messages",
    ),
    booleanControl(
      "display.showTurnTime",
      "Show Turn Time",
      "Show the total prompt-to-yield time (including tool calls) on assistant message usage rows",
    ),
    booleanControl(
      "display.cacheMissMarker",
      "Cache Miss Marker",
      "Show a divider after an assistant turn whose request lost (missed) the prompt cache",
    ),
    booleanControl(
      "display.collapseCompacted",
      "Collapse Compacted History",
      "Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point",
    ),
    booleanControl(
      "showHardwareCursor",
      "Show Hardware Cursor",
      "Show terminal cursor for IME support",
    ),
    booleanControl(
      "tui.imeSafeCursor",
      "IME-Safe Prompt Layout",
      "Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it",
    ),
    booleanControl(
      "task.showResolvedModelBadge",
      "Show Resolved Model Badge",
      "Display the actual model ID used by each subagent in the task widget status line",
    ),
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
      "Render images inline in the terminal",
    ),
    booleanControl(
      "images.autoResize",
      "Auto-Resize Images",
      "Resize large images to 2000x2000 max for better model compatibility",
    ),
    booleanControl(
      "images.blockImages",
      "Block Images",
      "Prevent images from being sent to LLM providers",
    ),
  ],
);

export const S1_APPEARANCE_SECTIONS: readonly SettingsSectionDescriptor[] = [
  THEME_SETTINGS_SECTION,
  COMPOSER_SETTINGS_SECTION,
  STATUS_LINE_SETTINGS_SECTION,
  DISPLAY_SETTINGS_SECTION,
  IMAGES_SETTINGS_SECTION,
];
