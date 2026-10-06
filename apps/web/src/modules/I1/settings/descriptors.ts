import type { JsonValue } from "@omp-app/contracts";
import type {
  ScalarSettingControl,
  SettingOption,
  SettingsSectionDescriptor,
  SettingValue,
  ValidationResult,
} from "../../S1/settings-kit";
import { McpSettingsSection } from "../contract";

const HOST_CONFIG = ["host.config"] as const;

export const MCP_SETTING_KEYS = [
  "mcp.enableProjectConfig",
  "mcp.startupTimeoutMs",
  "mcp.renderMarkdownResults",
  "mcp.notifications",
  "mcp.notificationDebounceMs",
  "tools.xdev",
  "tools.xdevDocs",
  "tools.xdevInlineDevices",
] as const;

export const MCP_SETTINGS_CONFIG = McpSettingsSection.parse({
  section: "tools/Discovery & MCP",
  keys: [...MCP_SETTING_KEYS],
});

function plainValue(value: SettingValue): JsonValue | undefined {
  return value.secret ? undefined : value.value;
}

function nonNegativeNumberValidator(value: SettingValue): ValidationResult {
  const candidate = plainValue(value);
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0)
    return { valid: true };
  return {
    valid: false,
    code: "non-negative-number",
    message: "Enter a finite, non-negative number.",
  };
}

function stringListValidator(value: SettingValue): ValidationResult {
  const candidate = plainValue(value);
  if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string"))
    return { valid: true };
  return { valid: false, code: "string-list", message: "Enter a list of text values." };
}

function settingControl(
  key: ScalarSettingControl["key"],
  label: string,
  description: string,
  kind: ScalarSettingControl["kind"],
  validate: ScalarSettingControl["validate"],
  apply: ScalarSettingControl["apply"],
  options?: ScalarSettingControl["options"],
): ScalarSettingControl {
  return {
    key,
    label,
    description,
    kind,
    secret: false,
    validate,
    apply,
    ...(options ? { options } : {}),
  };
}

function booleanControl(
  key: ScalarSettingControl["key"],
  label: string,
  description: string,
  apply: ScalarSettingControl["apply"],
): ScalarSettingControl {
  return settingControl(
    key,
    label,
    description,
    "boolean",
    (value) => {
      const candidate = plainValue(value);
      if (typeof candidate === "boolean") return { valid: true };
      return { valid: false, code: "boolean", message: "Choose on or off." };
    },
    apply,
  );
}

const docsOptions = [
  { value: "inline", label: "All Devices" },
  { value: "builtins", label: "Built-ins Only" },
  { value: "catalog", label: "Catalog Only" },
] as const satisfies readonly SettingOption[];

/**
 * Keys, kinds and labels follow omp v18.6.1's single Tools / Discovery & MCP settings group:
 * - mcp.enableProjectConfig at packages/coding-agent/src/mcp/settings.ts:10
 * - mcp.startupTimeoutMs at packages/coding-agent/src/mcp/settings.ts:22
 * - mcp.renderMarkdownResults at packages/coding-agent/src/mcp/settings.ts:34
 * - mcp.notifications at packages/coding-agent/src/mcp/settings.ts:47
 * - mcp.notificationDebounceMs at packages/coding-agent/src/mcp/settings.ts:59
 * - tools.xdev at packages/coding-agent/src/tools/settings.ts:913
 * - tools.xdevDocs at packages/coding-agent/src/tools/settings.ts:926
 * - tools.xdevInlineDevices at packages/coding-agent/src/tools/settings.ts:949
 * Defaults and effective provenance come from A1 ConfigStore; this kit descriptor does not create
 * a second settings store or copy default values into the controls.
 */
const controls: readonly ScalarSettingControl[] = [
  booleanControl(
    "mcp.enableProjectConfig",
    "MCP Project Config",
    "Load project-root MCP configuration files.",
    "live",
  ),
  settingControl(
    "mcp.startupTimeoutMs",
    "MCP Startup Window",
    "Wait this many milliseconds for initial MCP tool discovery; 0 waits until connections settle.",
    "number",
    nonNegativeNumberValidator,
    "restart",
  ),
  booleanControl(
    "mcp.renderMarkdownResults",
    "MCP Markdown Results",
    "Render non-JSON MCP text results as Markdown in the transcript.",
    "live",
  ),
  booleanControl(
    "mcp.notifications",
    "MCP Update Injection",
    "Inject MCP resource updates into the agent conversation.",
    "restart",
  ),
  settingControl(
    "mcp.notificationDebounceMs",
    "MCP Notification Debounce",
    "Wait this many milliseconds after an MCP resource update before injecting it.",
    "number",
    nonNegativeNumberValidator,
    "restart",
  ),
  booleanControl(
    "tools.xdev",
    "xd:// Tools",
    "Place rarely used tools behind device URLs instead of including every schema in each request.",
    "live",
  ),
  settingControl(
    "tools.xdevDocs",
    "xd:// Prompt Docs",
    "Choose whether device documentation and schemas are all inline, built-ins only, or available on demand.",
    "enum",
    (value) => {
      const candidate = plainValue(value);
      if (typeof candidate === "string" && ["inline", "builtins", "catalog"].includes(candidate))
        return { valid: true };
      return { valid: false, code: "enum", message: "Choose one of the available options." };
    },
    "live",
    docsOptions,
  ),
  settingControl(
    "tools.xdevInlineDevices",
    "xd:// Inline Devices",
    "Device-name patterns to keep inline when prompt docs are set to Built-ins Only.",
    "list",
    stringListValidator,
    "live",
  ),
];

export const MCP_SETTINGS_SECTION_DESCRIPTOR: SettingsSectionDescriptor = {
  id: "I1.mcpSettings",
  section: "tools/Discovery & MCP",
  title: "Tools / Discovery & MCP",
  inventory: ["S5.tools-discovery-mcp"],
  controls,
  requires: [...HOST_CONFIG],
};

export const I1_SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  MCP_SETTINGS_SECTION_DESCRIPTOR,
];
