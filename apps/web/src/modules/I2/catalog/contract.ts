import type {
  AppError,
  CapabilityKey,
  CapabilityMap,
  CommandMetadata,
  ExtensionCatalogChanged,
  ExtensionCatalogResult,
  ExtensionSource,
  ExtensionSummary,
  FolderPath,
  PortCallOptions,
  Revision,
} from "@omp-app/contracts";

const MAX_CATALOG_ITEMS = 1_000;
const MAX_PROMPTS = 2_000;
const MAX_CAPABILITIES = 32;
const MAX_TEXT = 2_000;
const MAX_IDENTIFIER = 256;
function isControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    )
      return true;
  }
  return false;
}
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

export const I2CapabilityKeys = {
  extensionCatalog: "host.extension-catalog",
  commandGateway: "host.command-gateway",
  skillsRegistry: "host.skills-registry",
  authGateway: "host.auth-gateway",
} as const satisfies Record<string, CapabilityKey>;

export type I2CapabilityKey = (typeof I2CapabilityKeys)[keyof typeof I2CapabilityKeys];

export interface ExtensionMetadata {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly source: ExtensionSource;
  readonly version?: string;
  readonly enabled: boolean;
  readonly shadowed: boolean;
  readonly capabilities: readonly string[];
  /** A1.13 exposes only an omp-root-relative path; unsafe paths are omitted. */
  readonly path?: string;
  readonly description?: string;
  readonly error?: string;
}

export interface PromptMetadata {
  readonly name: string;
  readonly provider: string;
  readonly source: ExtensionSource;
  readonly enabled: boolean;
  /** A1.13 exposes only an omp-root-relative path; unsafe paths are omitted. */
  readonly path?: string;
  readonly description?: string;
}

export interface CatalogSourceSummary {
  readonly source: ExtensionSource;
  readonly provider: string;
  readonly total: number;
  readonly enabled: number;
  readonly shadowed: number;
}

export interface ExtensionCatalogSnapshot {
  readonly revision: Revision;
  readonly extensions: readonly ExtensionMetadata[];
  readonly skills: readonly ExtensionMetadata[];
  readonly prompts: readonly PromptMetadata[];
  readonly sources: readonly CatalogSourceSummary[];
  readonly truncated: boolean;
}

export interface ExtensionCatalog {
  list(folder: FolderPath | null, options?: PortCallOptions): Promise<ExtensionCatalogSnapshot>;
  reload(folder: FolderPath | null, options?: PortCallOptions): Promise<ExtensionCatalogSnapshot>;
  subscribe(listener: (change: ExtensionCatalogChanged) => void): Promise<() => Promise<void>>;
}

export function isI2CapabilityAvailable(
  capabilities: CapabilityMap,
  key: I2CapabilityKey,
): boolean {
  return capabilities[key]?.state === "available";
}

/** Removes control characters and bounds untrusted catalog text before it reaches UI state. */
export function sanitizeCatalogText(value: string, limit = MAX_TEXT): string | undefined {
  const sanitized = [...value]
    .filter((character) => !isControlCharacter(character))
    .join("")
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, limit) : undefined;
}

function identifier(value: string, fallback: string): string {
  return sanitizeCatalogText(value, MAX_IDENTIFIER) ?? fallback;
}

/** Keeps only A1.13's relative metadata path; the browser never derives or accepts host paths. */
export function sanitizeCatalogPath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (ABSOLUTE_PATH.test(normalized) || normalized.split("/").includes("..")) return undefined;
  return sanitizeCatalogText(normalized, MAX_IDENTIFIER);
}

function safeCapabilities(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [
      ...new Set(values.map((value) => sanitizeCatalogText(value, MAX_IDENTIFIER)).filter(Boolean)),
    ].slice(0, MAX_CAPABILITIES) as string[],
  );
}

function safePath(value: string): { readonly path?: string } {
  const path = sanitizeCatalogPath(value);
  return path === undefined ? {} : { path };
}

function normalizeExtension(summary: ExtensionSummary): ExtensionMetadata {
  const description =
    summary.description === undefined ? undefined : sanitizeCatalogText(summary.description);
  const version =
    summary.version === undefined ? undefined : sanitizeCatalogText(summary.version, 256);
  const error = summary.error === undefined ? undefined : sanitizeCatalogText(summary.error);
  return Object.freeze({
    id: identifier(summary.id, "unknown-extension"),
    name: identifier(summary.name, "Unnamed extension"),
    provider: identifier(summary.provider, "unknown-provider"),
    source: summary.source,
    ...(version === undefined ? {} : { version }),
    enabled: summary.enabled,
    shadowed: summary.shadowed,
    capabilities: safeCapabilities(summary.capabilities),
    ...safePath(summary.path),
    ...(description === undefined ? {} : { description }),
    ...(error === undefined ? {} : { error }),
  });
}

function normalizePrompt(command: CommandMetadata): PromptMetadata {
  const description =
    command.description === undefined ? undefined : sanitizeCatalogText(command.description);
  return Object.freeze({
    name: identifier(command.name, "unknown-command"),
    provider: identifier(command.provider, "unknown-provider"),
    source: command.source,
    enabled: command.enabled,
    ...safePath(command.path),
    ...(description === undefined ? {} : { description }),
  });
}

function sourceSummaries(items: readonly ExtensionMetadata[]): readonly CatalogSourceSummary[] {
  const summaries = new Map<
    string,
    { source: ExtensionSource; provider: string; total: number; enabled: number; shadowed: number }
  >();
  for (const item of items) {
    const key = `${item.source}:${item.provider}`;
    const previous = summaries.get(key) ?? {
      source: item.source,
      provider: item.provider,
      total: 0,
      enabled: 0,
      shadowed: 0,
    };
    previous.total += 1;
    if (item.enabled) previous.enabled += 1;
    if (item.shadowed) previous.shadowed += 1;
    summaries.set(key, previous);
  }
  return Object.freeze(
    [...summaries.values()]
      .sort((left, right) =>
        `${left.source}:${left.provider}`.localeCompare(`${right.source}:${right.provider}`),
      )
      .map((summary) => Object.freeze(summary)),
  );
}

export function normalizeCatalog(result: ExtensionCatalogResult): ExtensionCatalogSnapshot {
  const extensions = result.extensions.slice(0, MAX_CATALOG_ITEMS).map(normalizeExtension);
  const skills = extensions.filter((item) => item.source === "skill");
  const installed = extensions.filter((item) => item.source !== "skill");
  const prompts = result.commands.slice(0, MAX_PROMPTS).map(normalizePrompt);
  return Object.freeze({
    revision: result.revision,
    extensions: Object.freeze(installed),
    skills: Object.freeze(skills),
    prompts: Object.freeze(prompts),
    sources: sourceSummaries(extensions),
    truncated: result.extensions.length > MAX_CATALOG_ITEMS || result.commands.length > MAX_PROMPTS,
  });
}

export function capabilityFailure(key: I2CapabilityKey, action: string): AppError {
  return {
    code: "unavailable",
    message: `${action} is unavailable until the required host capability is connected.`,
    retryable: false,
    capability: key,
  };
}
