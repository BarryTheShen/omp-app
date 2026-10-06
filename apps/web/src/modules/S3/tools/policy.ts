import type {
  ConfigEntry,
  ConfigSource,
  FolderPath,
  JsonValue,
  Provenance,
  Revision,
  SettingSource,
} from "@omp-app/contracts";
import type { ConfigSnapshot, SettingControl } from "../../S1/settings-kit";
import {
  TOOLS_AVAILABLE_SECTION,
  TOOLS_COMPUTER_SECTION,
  TOOLS_DEVELOPER_SECTION,
  TOOLS_EXECUTION_SECTION,
  TOOLS_EXTENSIONS_SECTION,
  TOOLS_GITHUB_SECTION,
  TOOLS_GREP_BROWSER_SECTION,
  TOOLS_IDA_PRO_SECTION,
  TOOLS_OUTPUT_LIMITS_SECTION,
  TOOLS_TODOS_SECTION,
} from "../sections";

/** The ten S3 sections whose controls are consumed by tool-card modules. */
export const TOOLS_SETTINGS_SECTIONS = [
  TOOLS_AVAILABLE_SECTION,
  TOOLS_GREP_BROWSER_SECTION,
  TOOLS_COMPUTER_SECTION,
  TOOLS_GITHUB_SECTION,
  TOOLS_OUTPUT_LIMITS_SECTION,
  TOOLS_EXECUTION_SECTION,
  TOOLS_EXTENSIONS_SECTION,
  TOOLS_DEVELOPER_SECTION,
  TOOLS_IDA_PRO_SECTION,
  TOOLS_TODOS_SECTION,
] as const;

export const TOOLS_SECTION_IDS = [
  "S3.toolsAvailable",
  "S3.toolsGrepBrowser",
  "S3.toolsComputer",
  "S3.toolsGithub",
  "S3.toolsOutputLimits",
  "S3.toolsExecution",
  "S3.toolsExtensions",
  "S3.toolsDeveloper",
  "S3.toolsIdaPro",
  "S3.toolsTodos",
] as const;

export type ToolsSectionId = (typeof TOOLS_SECTION_IDS)[number];

/**
 * omp v18.6.1 defaults; each key cites its exact registration below. Effective values and
 * provenance come from A1 ConfigStore; these defaults are the safe fallback when no entry exists.
 */
export const TOOLS_SETTING_DEFAULTS = {
  // boolean true; packages/coding-agent/src/tools/settings.ts:348-351.
  "todo.enabled": true,
  // boolean true; packages/coding-agent/src/tools/settings.ts:434-437.
  "glob.enabled": true,
  // boolean true; packages/coding-agent/src/tools/settings.ts:446-449.
  "grep.enabled": true,
  // boolean false; packages/coding-agent/src/tools/settings.ts:497-500.
  "astGrep.enabled": false,
  // boolean true; packages/coding-agent/src/tools/settings.ts:509-512.
  "astEdit.enabled": true,
  // enum "auto"; packages/coding-agent/src/tools/settings.ts:520-524.
  "find.enabled": "auto",
  // boolean true; packages/coding-agent/src/tools/settings.ts:545-549.
  "debug.enabled": true,
  // boolean true; packages/coding-agent/src/tools/settings.ts:557-561.
  "launch.enabled": true,
  // boolean false; packages/coding-agent/src/tools/settings.ts:569-573.
  "speechgen.enabled": false,
  // boolean false; packages/coding-agent/src/tools/settings.ts:581-585.
  "generate_image.enabled": false,
  // boolean false; packages/coding-agent/src/tools/settings.ts:594-598.
  "computer.enabled": false,
  // boolean false; packages/coding-agent/src/tools/settings.ts:606-610.
  "ratchet.enabled": false,
  // boolean true; packages/coding-agent/src/tools/settings.ts:618-622.
  "archive.enabled": true,
  // boolean false; packages/coding-agent/src/tools/settings.ts:687-691.
  "checkpoint.enabled": false,
  // boolean true; packages/coding-agent/src/tools/settings.ts:700-704.
  "fetch.enabled": true,
  // boolean false; packages/coding-agent/src/tools/settings.ts:712-716.
  "vault.enabled": false,
  // boolean false; packages/coding-agent/src/tools/settings.ts:725-729.
  "github.enabled": false,
  // boolean true; packages/coding-agent/src/tools/settings.ts:775-779.
  "web_search.enabled": true,
  // boolean false; packages/coding-agent/src/tools/settings.ts:787-791.
  "security.enabled": false,
  // boolean true; packages/coding-agent/src/tools/settings.ts:800-804.
  "ask.enabled": true,
  // boolean true; packages/coding-agent/src/tools/browser/settings.ts:7-11.
  "browser.enabled": true,
  // boolean true; packages/coding-agent/src/ida/settings.ts:8-12.
  "ida.enabled": true,
  // number 1; packages/coding-agent/src/tools/settings.ts:457-461.
  "grep.contextBefore": 1,
  // number 3; packages/coding-agent/src/tools/settings.ts:476-480.
  "grep.contextAfter": 3,
  // string undefined; packages/coding-agent/src/tools/browser/settings.ts:19-23.
  "browser.cdpUrl": undefined,
  // boolean false; packages/coding-agent/src/tools/browser/settings.ts:32-36.
  "browser.relay": false,
  // string undefined; packages/coding-agent/src/tools/browser/settings.ts:45-49.
  "browser.relayUrl": undefined,
  // boolean true; packages/coding-agent/src/tools/browser/settings.ts:57-61.
  "browser.headless": true,
  // boolean true; packages/coding-agent/src/tools/browser/settings.ts:69-73.
  "browser.cmux": true,
  // boolean true; packages/coding-agent/src/tools/browser/settings.ts:82-86.
  "browser.tern": true,
  // boolean true; packages/coding-agent/src/tools/browser/settings.ts:95-99.
  "browser.freezeOnTurnEnd": true,
  // number 1800; packages/coding-agent/src/tools/browser/settings.ts:108-112.
  "browser.idleCloseSec": 1800,
  // string undefined; packages/coding-agent/src/tools/browser/settings.ts:127-131.
  "browser.screenshotDir": undefined,
  // string "all"; packages/coding-agent/src/tools/settings.ts:631-635.
  "computer.display": "all",
  // number 3840; packages/coding-agent/src/tools/settings.ts:643-647.
  "computer.maxWidth": 3840,
  // number 2400; packages/coding-agent/src/tools/settings.ts:655-659.
  "computer.maxHeight": 2400,
  // boolean true; packages/coding-agent/src/tools/settings.ts:738-742.
  "github.cache.enabled": true,
  // number 300; packages/coding-agent/src/tools/settings.ts:750-754.
  "github.cache.softTtlSec": 300,
  // number 604800; packages/coding-agent/src/tools/settings.ts:762-766.
  "github.cache.hardTtlSec": 604800,
  // number 50; packages/coding-agent/src/tools/settings.ts:12-16.
  "tools.artifactSpillThreshold": 50,
  // number 20; packages/coding-agent/src/tools/settings.ts:38-42.
  "tools.artifactTailBytes": 20,
  // number 20; packages/coding-agent/src/tools/settings.ts:60-64.
  "tools.artifactHeadBytes": 20,
  // number 768; packages/coding-agent/src/tools/settings.ts:84-88.
  "tools.outputMaxColumns": 768,
  // number 500; packages/coding-agent/src/tools/settings.ts:106-110.
  "tools.artifactTailLines": 500,
  // number 16; packages/coding-agent/src/tools/settings.ts:127-131.
  "tools.artifactMaxBytes": 16,
  // number 300000; packages/coding-agent/src/tools/settings.ts:667-671.
  "images.questionTimeoutMs": 300_000,
  // boolean true; packages/coding-agent/src/tools/settings.ts:813-817.
  "tools.intentTracing": true,
  // boolean true; packages/coding-agent/src/tools/settings.ts:826-830.
  "tools.abortOnFabricatedResult": true,
  // boolean false; packages/coding-agent/src/tools/settings.ts:839-843.
  "tools.speculativeExecution.enabled": false,
  // number 2; packages/coding-agent/src/tools/settings.ts:852-856.
  "tools.speculativeExecution.maxInFlight": 2,
  // number 0; packages/coding-agent/src/tools/settings.ts:870-874.
  "tools.maxTimeout": 0,
  // boolean true (RPC protocol default); packages/coding-agent/src/tools/settings.ts:892-896.
  "async.enabled": true,
  // number 100 (RPC protocol default); packages/coding-agent/src/tools/settings.ts:905-909.
  "async.maxJobs": 100,
  // number 30000; packages/coding-agent/src/extensibility/settings.ts:152-156.
  "extensionHandlers.toolCallTimeoutMs": 30_000,
  // boolean true; packages/coding-agent/src/tools/settings.ts:961-965.
  "dev.autoqa": true,
  // string URL; packages/coding-agent/src/tools/settings.ts:975-979.
  "dev.autoqaPush.endpoint": "https://qa.omp.sh/v1/grievances",
  // string ""; packages/coding-agent/src/ida/settings.ts:22-26.
  "ida.python": "",
  // string ""; packages/coding-agent/src/ida/settings.ts:35-39.
  "ida.installDir": "",
  // number 4; packages/coding-agent/src/ida/settings.ts:49-53.
  "ida.maxOpen": 4,
  // number 900; packages/coding-agent/src/ida/settings.ts:69-73.
  "ida.idleCloseSec": 900,
  // boolean true; packages/coding-agent/src/tools/settings.ts:359-363.
  "todo.reminders": true,
  // number 3; packages/coding-agent/src/tools/settings.ts:371-375.
  "todo.remindersMax": 3,
  // enum "default"; packages/coding-agent/src/tools/settings.ts:389-393.
  "todo.eager": "default",
  // number 60; packages/coding-agent/src/tools/settings.ts:411-415.
  "tasks.todoClearDelay": 60,
} as const satisfies Readonly<Record<string, boolean | number | string | undefined>>;

export type ToolsSettingKey = keyof typeof TOOLS_SETTING_DEFAULTS;

export type ToolApprovalDecision = "allow" | "deny" | "prompt";
export type ToolApprovalMode = "always-ask" | "write" | "yolo";
export type DeveloperAutoqaConsent = "unset" | "granted" | "denied";

const DEFAULT_APPROVAL_OVERRIDES: Readonly<Record<string, ToolApprovalDecision>> = Object.freeze(
  {},
);
const DEFAULT_APPROVAL_MODE: ToolApprovalMode = "yolo";

/** Read-only policy inputs with no S3 controls; the approval map is a record in omp. */
export const TOOLS_APPROVAL_DEFAULTS = Object.freeze({
  mode: DEFAULT_APPROVAL_MODE,
  perTool: DEFAULT_APPROVAL_OVERRIDES,
});

/** Typed-only inputs retain defaults and provenance without adding controls or S3 section claims:
 * `tools.approval` is a record with default `{}` (`packages/coding-agent/src/tools/settings.ts:294-297`);
 * `tools.approvalMode` defaults to `"yolo"` (`packages/coding-agent/src/tools/settings.ts:311-315`);
 * `dev.autoqaPush.token` is a credential string with default `undefined`; only its status is
 * projected (`packages/coding-agent/src/tools/settings.ts:987-991`);
 * developer consent defaults to `"unset"` (`packages/coding-agent/src/tools/settings.ts:1007-1011`).
 */
export const TOOLS_POLICY_CONFIG_KEYS = [
  "tools.approval",
  "tools.approvalMode",
  "dev.autoqaPush.token",
  "dev.autoqaConsent",
] as const;

export type ToolsPolicyKey = ToolsSettingKey | (typeof TOOLS_POLICY_CONFIG_KEYS)[number];

export function isToolsPolicyConfigKey(key: string): key is ToolsPolicyKey {
  return (
    Object.hasOwn(TOOLS_SETTING_DEFAULTS, key) ||
    TOOLS_POLICY_CONFIG_KEYS.some((policyKey) => policyKey === key)
  );
}

type Widen<Value> = Value extends boolean
  ? boolean
  : Value extends number
    ? number
    : Value extends string
      ? string
      : Value;

export type ToolsSettingValues = {
  readonly [Key in ToolsSettingKey]: Key extends "find.enabled"
    ? "auto" | "on" | "off"
    : Key extends "todo.eager"
      ? "default" | "preferred" | "always"
      : Key extends "browser.cdpUrl" | "browser.relayUrl" | "browser.screenshotDir"
        ? string | undefined
        : Widen<(typeof TOOLS_SETTING_DEFAULTS)[Key]>;
};

export type ToolSettingProvenance = {
  readonly source: ConfigSource;
  readonly overrides: readonly SettingSource[];
  readonly provenance?: Provenance;
};

export type ToolsAvailabilityPolicy = {
  readonly todo: boolean;
  readonly glob: boolean;
  readonly grep: boolean;
  readonly astGrep: boolean;
  readonly astEdit: boolean;
  readonly find: "auto" | "on" | "off";
  readonly debug: boolean;
  readonly launch: boolean;
  readonly speechgen: boolean;
  readonly generateImage: boolean;
  readonly computer: boolean;
  readonly ratchet: boolean;
  readonly archive: boolean;
  readonly checkpoint: boolean;
  readonly fetch: boolean;
  readonly vault: boolean;
  readonly github: boolean;
  readonly webSearch: boolean;
  readonly security: boolean;
  readonly ask: boolean;
  readonly browser: boolean;
  readonly ida: boolean;
};

export type ToolsGrepBrowserPolicy = {
  readonly contextBefore: number;
  readonly contextAfter: number;
  readonly cdpUrl: string | undefined;
  readonly relay: boolean;
  readonly relayUrl: string | undefined;
  readonly headless: boolean;
  readonly cmux: boolean;
  readonly tern: boolean;
  readonly freezeOnTurnEnd: boolean;
  readonly idleCloseSec: number;
  readonly screenshotDir: string | undefined;
};

export type ToolsComputerPolicy = {
  readonly display: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
};

export type ToolsGithubPolicy = {
  readonly cacheEnabled: boolean;
  readonly cacheSoftTtlSec: number;
  readonly cacheHardTtlSec: number;
};

export type ToolsOutputLimitsPolicy = {
  readonly artifactSpillThreshold: number;
  readonly artifactTailBytes: number;
  readonly artifactHeadBytes: number;
  readonly outputMaxColumns: number;
  readonly artifactTailLines: number;
  readonly artifactMaxBytes: number;
};

export type ToolsExecutionPolicy = {
  readonly imageQuestionTimeoutMs: number;
  readonly intentTracing: boolean;
  readonly abortOnFabricatedResult: boolean;
  readonly speculativeExecutionEnabled: boolean;
  readonly speculativeExecutionMaxInFlight: number;
  readonly maxTimeout: number;
  readonly asyncEnabled: boolean;
  readonly asyncMaxJobs: number;
};

export type ToolsExtensionsPolicy = {
  readonly toolCallTimeoutMs: number;
};

export type ToolsApprovalPolicy = {
  readonly mode: ToolApprovalMode;
  readonly perTool: Readonly<Record<string, ToolApprovalDecision>>;
  readonly provenance: Readonly<{
    mode: ToolSettingProvenance;
    perTool: ToolSettingProvenance;
  }>;
};

export type ToolsSecretStatus = {
  readonly isSet: boolean;
  readonly provenance: ToolSettingProvenance;
};

export type ToolsDeveloperPolicy = {
  readonly autoqa: boolean;
  readonly autoqaPushEndpoint: string;
  readonly autoqaPushToken: ToolsSecretStatus;
  readonly autoqaConsent: DeveloperAutoqaConsent;
  readonly autoqaConsentProvenance: ToolSettingProvenance;
};

export type ToolsIdaPolicy = {
  readonly enabled: boolean;
  readonly python: string;
  readonly installDir: string;
  readonly maxOpen: number;
  readonly idleCloseSec: number;
};

export type ToolsTodosPolicy = {
  readonly enabled: boolean;
  readonly reminders: boolean;
  readonly remindersMax: number;
  readonly eager: "default" | "preferred" | "always";
  readonly todoClearDelay: number;
};

export type ToolsPolicySnapshot = {
  readonly revision: Revision;
  readonly folder: FolderPath | null;
  readonly settings: ToolsSettingValues;
  readonly provenance: Readonly<{ [Key in ToolsSettingKey]: ToolSettingProvenance }>;
  /** Keys whose ConfigStore entry was secret; no secret payload is projected. */
  readonly redacted: readonly ToolsPolicyKey[];
  /** Keys with a malformed value; the safe v18.6.1 default is projected instead. */
  readonly invalid: readonly ToolsPolicyKey[];
  readonly availability: ToolsAvailabilityPolicy;
  readonly grepBrowser: ToolsGrepBrowserPolicy;
  readonly computer: ToolsComputerPolicy;
  readonly github: ToolsGithubPolicy;
  readonly outputLimits: ToolsOutputLimitsPolicy;
  readonly execution: ToolsExecutionPolicy;
  readonly extensions: ToolsExtensionsPolicy;
  readonly developer: ToolsDeveloperPolicy;
  readonly ida: ToolsIdaPolicy;
  readonly todos: ToolsTodosPolicy;
  readonly approval: ToolsApprovalPolicy;
};

export type ToolsConfigSnapshot = {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly entries: readonly ConfigEntry[];
  readonly sections: Readonly<{ [Section in ToolsSectionId]: ConfigSnapshot }>;
};

const CONTROL_BY_KEY = Object.fromEntries(
  TOOLS_SETTINGS_SECTIONS.flatMap((section) =>
    section.controls.map((control) => [
      control.key,
      { control, sectionId: section.id as ToolsSectionId },
    ]),
  ),
) as Partial<
  Record<ToolsSettingKey, { readonly control: SettingControl; readonly sectionId: ToolsSectionId }>
>;

const DEFAULT_PROVENANCE: ToolSettingProvenance = Object.freeze({
  source: "default",
  overrides: Object.freeze([]),
  provenance: Object.freeze({ origin: "host-fallback", ompVersion: "18.6.1" }),
});

function provenanceFor(entry: ConfigEntry | undefined): ToolSettingProvenance {
  if (!entry) return DEFAULT_PROVENANCE;
  return Object.freeze({
    source: entry.source,
    overrides: Object.freeze([...entry.overrides]),
    ...(entry.provenance === undefined
      ? {}
      : { provenance: Object.freeze({ ...entry.provenance }) }),
  });
}

function accepts(
  registration: { readonly control: SettingControl; readonly sectionId: ToolsSectionId },
  value: JsonValue,
  snapshot: ToolsConfigSnapshot,
): boolean {
  return registration.control.validate(
    { secret: false, value },
    snapshot.sections[registration.sectionId],
  ).valid;
}

function projectValues(snapshot: ToolsConfigSnapshot): {
  readonly settings: ToolsSettingValues;
  readonly provenance: Readonly<{ [Key in ToolsSettingKey]: ToolSettingProvenance }>;
  readonly redacted: readonly ToolsPolicyKey[];
  readonly invalid: readonly ToolsPolicyKey[];
} {
  const entries = new Map(snapshot.entries.map((entry) => [entry.key, entry]));
  const values = {} as Record<ToolsSettingKey, ToolsSettingValues[ToolsSettingKey]>;
  const provenance = {} as {
    -readonly [Key in ToolsSettingKey]: ToolSettingProvenance;
  };
  const redacted: ToolsPolicyKey[] = [];
  const invalid: ToolsPolicyKey[] = [];

  for (const key of Object.keys(TOOLS_SETTING_DEFAULTS) as ToolsSettingKey[]) {
    const fallback = TOOLS_SETTING_DEFAULTS[key] as ToolsSettingValues[typeof key];
    const registration = CONTROL_BY_KEY[key];
    const entry = entries.get(key);
    if (!entry || entry.secret) {
      values[key] = fallback;
      provenance[key] = provenanceFor(entry);
      if (entry?.secret) redacted.push(key);
      continue;
    }
    if (!registration || !accepts(registration, entry.value, snapshot)) {
      values[key] = fallback;
      provenance[key] = provenanceFor(entry);
      invalid.push(key);
      continue;
    }
    values[key] = entry.value as ToolsSettingValues[typeof key];
    provenance[key] = provenanceFor(entry);
  }

  return {
    settings: Object.freeze(values) as ToolsSettingValues,
    provenance: Object.freeze(provenance) as Readonly<{
      [Key in ToolsSettingKey]: ToolSettingProvenance;
    }>,
    redacted: Object.freeze(redacted),
    invalid: Object.freeze(invalid),
  };
}

function isToolApprovalMode(value: JsonValue): value is ToolApprovalMode {
  return value === "always-ask" || value === "write" || value === "yolo";
}

function isToolApprovalDecision(value: JsonValue): value is ToolApprovalDecision {
  return value === "allow" || value === "deny" || value === "prompt";
}

function parseToolApprovalOverrides(
  value: JsonValue,
): Readonly<Record<string, ToolApprovalDecision>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: [string, ToolApprovalDecision][] = [];
  for (const [tool, decision] of Object.entries(value)) {
    if (!isToolApprovalDecision(decision)) return undefined;
    entries.push([tool, decision]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function projectApprovalPolicy(
  entries: ReadonlyMap<string, ConfigEntry>,
  invalid: ToolsPolicyKey[],
  redacted: ToolsPolicyKey[],
): ToolsApprovalPolicy {
  const modeEntry = entries.get("tools.approvalMode");
  let mode: ToolApprovalMode = TOOLS_APPROVAL_DEFAULTS.mode;
  if (modeEntry?.secret) redacted.push("tools.approvalMode");
  else if (modeEntry) {
    if (isToolApprovalMode(modeEntry.value)) mode = modeEntry.value;
    else invalid.push("tools.approvalMode");
  }

  const overridesEntry = entries.get("tools.approval");
  let perTool = TOOLS_APPROVAL_DEFAULTS.perTool;
  if (overridesEntry?.secret) redacted.push("tools.approval");
  else if (overridesEntry) {
    const parsed = parseToolApprovalOverrides(overridesEntry.value);
    if (parsed) perTool = parsed;
    else invalid.push("tools.approval");
  }
  return Object.freeze({
    mode,
    perTool,
    provenance: Object.freeze({
      mode: provenanceFor(modeEntry),
      perTool: provenanceFor(overridesEntry),
    }),
  });
}

function projectAutoqaPushToken(
  entry: ConfigEntry | undefined,
  invalid: ToolsPolicyKey[],
  redacted: ToolsPolicyKey[],
): ToolsSecretStatus {
  if (!entry) return Object.freeze({ isSet: false, provenance: DEFAULT_PROVENANCE });
  if (entry.secret) {
    redacted.push("dev.autoqaPush.token");
    return Object.freeze({ isSet: entry.isSet, provenance: provenanceFor(entry) });
  }
  invalid.push("dev.autoqaPush.token");
  return Object.freeze({ isSet: false, provenance: provenanceFor(entry) });
}

function projectAutoqaConsent(
  entry: ConfigEntry | undefined,
  invalid: ToolsPolicyKey[],
  redacted: ToolsPolicyKey[],
): DeveloperAutoqaConsent {
  if (!entry) return "unset";
  if (entry.secret) {
    redacted.push("dev.autoqaConsent");
    return "unset";
  }
  if (entry.value === "unset" || entry.value === "granted" || entry.value === "denied") {
    return entry.value;
  }
  invalid.push("dev.autoqaConsent");
  return "unset";
}

/** Project only safe, typed values for T1/T2/T3/T4/T7 tool-card consumers. */
export function projectToolsPolicy(snapshot: ToolsConfigSnapshot): ToolsPolicySnapshot {
  const projected = projectValues(snapshot);
  const values = projected.settings;
  const entries = new Map(snapshot.entries.map((entry) => [entry.key, entry]));
  const invalid: ToolsPolicyKey[] = [...projected.invalid];
  const redacted: ToolsPolicyKey[] = [...projected.redacted];
  const approval = projectApprovalPolicy(entries, invalid, redacted);
  const autoqaPushToken = projectAutoqaPushToken(
    entries.get("dev.autoqaPush.token"),
    invalid,
    redacted,
  );
  const autoqaConsentEntry = entries.get("dev.autoqaConsent");
  const autoqaConsent = projectAutoqaConsent(autoqaConsentEntry, invalid, redacted);
  return Object.freeze({
    revision: snapshot.revision,
    folder: snapshot.folder,
    settings: projected.settings,
    provenance: projected.provenance,
    redacted: Object.freeze(redacted),
    invalid: Object.freeze(invalid),
    availability: Object.freeze({
      todo: values["todo.enabled"],
      glob: values["glob.enabled"],
      grep: values["grep.enabled"],
      astGrep: values["astGrep.enabled"],
      astEdit: values["astEdit.enabled"],
      find: values["find.enabled"],
      debug: values["debug.enabled"],
      launch: values["launch.enabled"],
      speechgen: values["speechgen.enabled"],
      generateImage: values["generate_image.enabled"],
      computer: values["computer.enabled"],
      ratchet: values["ratchet.enabled"],
      archive: values["archive.enabled"],
      checkpoint: values["checkpoint.enabled"],
      fetch: values["fetch.enabled"],
      vault: values["vault.enabled"],
      github: values["github.enabled"],
      webSearch: values["web_search.enabled"],
      security: values["security.enabled"],
      ask: values["ask.enabled"],
      browser: values["browser.enabled"],
      ida: values["ida.enabled"],
    }),
    grepBrowser: Object.freeze({
      contextBefore: values["grep.contextBefore"],
      contextAfter: values["grep.contextAfter"],
      cdpUrl: values["browser.cdpUrl"],
      relay: values["browser.relay"],
      relayUrl: values["browser.relayUrl"],
      headless: values["browser.headless"],
      cmux: values["browser.cmux"],
      tern: values["browser.tern"],
      freezeOnTurnEnd: values["browser.freezeOnTurnEnd"],
      idleCloseSec: values["browser.idleCloseSec"],
      screenshotDir: values["browser.screenshotDir"],
    }),
    computer: Object.freeze({
      display: values["computer.display"],
      maxWidth: values["computer.maxWidth"],
      maxHeight: values["computer.maxHeight"],
    }),
    github: Object.freeze({
      cacheEnabled: values["github.cache.enabled"],
      cacheSoftTtlSec: values["github.cache.softTtlSec"],
      cacheHardTtlSec: values["github.cache.hardTtlSec"],
    }),
    outputLimits: Object.freeze({
      artifactSpillThreshold: values["tools.artifactSpillThreshold"],
      artifactTailBytes: values["tools.artifactTailBytes"],
      artifactHeadBytes: values["tools.artifactHeadBytes"],
      outputMaxColumns: values["tools.outputMaxColumns"],
      artifactTailLines: values["tools.artifactTailLines"],
      artifactMaxBytes: values["tools.artifactMaxBytes"],
    }),
    execution: Object.freeze({
      imageQuestionTimeoutMs: values["images.questionTimeoutMs"],
      intentTracing: values["tools.intentTracing"],
      abortOnFabricatedResult: values["tools.abortOnFabricatedResult"],
      speculativeExecutionEnabled: values["tools.speculativeExecution.enabled"],
      speculativeExecutionMaxInFlight: values["tools.speculativeExecution.maxInFlight"],
      maxTimeout: values["tools.maxTimeout"],
      asyncEnabled: values["async.enabled"],
      asyncMaxJobs: values["async.maxJobs"],
    }),
    extensions: Object.freeze({ toolCallTimeoutMs: values["extensionHandlers.toolCallTimeoutMs"] }),
    developer: Object.freeze({
      autoqa: values["dev.autoqa"],
      autoqaPushEndpoint:
        values["dev.autoqaPush.endpoint"] ?? TOOLS_SETTING_DEFAULTS["dev.autoqaPush.endpoint"],
      autoqaPushToken,
      autoqaConsent,
      autoqaConsentProvenance: provenanceFor(autoqaConsentEntry),
    }),
    ida: Object.freeze({
      enabled: values["ida.enabled"],
      python: values["ida.python"],
      installDir: values["ida.installDir"],
      maxOpen: values["ida.maxOpen"],
      idleCloseSec: values["ida.idleCloseSec"],
    }),
    todos: Object.freeze({
      enabled: values["todo.enabled"],
      reminders: values["todo.reminders"],
      remindersMax: values["todo.remindersMax"],
      eager: values["todo.eager"],
      todoClearDelay: values["tasks.todoClearDelay"],
    }),
    approval,
  });
}

/** Return the descriptor that owns one Tools setting key. */
export function toolsSectionForKey(key: ToolsSettingKey): (typeof TOOLS_SETTINGS_SECTIONS)[number] {
  const section = TOOLS_SETTINGS_SECTIONS.find((candidate) =>
    candidate.controls.some((control) => control.key === key),
  );
  if (!section) throw new Error(`Unknown Tools setting ${key}`);
  return section;
}
