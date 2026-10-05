import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AppFailure,
  type ConfigChanged,
  type ConfigEntry,
  type ConfigListResult,
  type ConfigReadArgs,
  type ConfigSource,
  type ConfigWriteArgs,
  type ConfigWriteResult,
  FolderPath,
  type JsonValue,
  type SettingSource,
} from "@omp-app/contracts";
import { type Document, parseDocument } from "yaml";
import {
  compareAndSwapFile,
  type FileSnapshot,
  type FileWatcher,
  hashContent,
  readFileSnapshot,
  watchFile,
} from "../fs";

const OMP_VERSION = "18.6.1";
const CONFIG_FILE = "config.yml";
const CONFIG_FALLBACK_FILE = "config.yaml";
const APP_CONFIG_FILE = CONFIG_FILE;

/**
 * omp's v18.6.1 registry marks a setting as credential-bearing with
 * `credential: true` or `ui.secret: true` (config/registry.ts:88-107 and
 * config/registry.ts:508-511). The app cannot import omp's registry, so callers
 * may provide those schema-marked keys explicitly. The conservative fallback
 * catches the credential-like key names used by omp's schema (apiKey, token,
 * password, secret, credential, and key material) without ever returning the
 * stored value.
 */
const CREDENTIAL_SEGMENT =
  /^(?:api[-_]?key|access[-_]?key|private[-_]?key|signing[-_]?key|encryption[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|oauth[-_]?token|api[-_]?token|bearer|token|password|passphrase|secret|credential|credentials)$/i;
// Header maps carry Authorization and API-key headers under arbitrary names, so all of them are secret.
const CREDENTIAL_PARENT = /^(?:secrets?|credentials?|oauth|headers?)$/i;

/**
 * Values that look like credentials make their setting secret whatever its key: defence in depth for
 * header values, URLs with userinfo and keys named outside the pattern above (main-agent review,
 * 2026-10-05). Mirrors the PR gate's secret patterns.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

const CONFIG_LAYERS = ["global", "project", "app"] as const;
type PersistedLayer = (typeof CONFIG_LAYERS)[number];
type PersistedSource = Exclude<ConfigSource, "env" | "runtime" | "overlay" | "default">;

export interface ConfigStoreOptions {
  /** Environment used to choose omp's agent/profile and app data directories. */
  readonly env?: Record<string, string | undefined>;
  /** Home directory used when `PI_CODING_AGENT_DIR` and `OMP_PROFILE` are absent. */
  readonly homeDir?: string;
  /** Explicit omp agent directory; useful for tests and isolated hosts. */
  readonly agentDir?: string;
  /** Explicit app-owned data directory; useful for tests. */
  readonly appDataDir?: string;
  /** Optional values supplied by the running omp process's environment layer. */
  readonly environmentValues?: Readonly<Record<string, unknown>>;
  /** Optional values supplied by the running omp process's runtime layer. */
  readonly runtimeValues?: Readonly<Record<string, unknown>>;
  /** Optional values supplied by an explicit `--config`/`PI_CONFIG_FILES` overlay. */
  readonly overlayValues?: Readonly<Record<string, unknown>>;
  /** Optional schema defaults; omp's full registry remains the source of truth. */
  readonly defaultValues?: Readonly<Record<string, unknown>>;
  /** Environment values declared as fallback settings, which rank below global/project. */
  readonly fallbackEnvironmentKeys?: readonly string[] | ReadonlySet<string>;
  /** Additional keys known to be marked `credential` or `ui.secret` by omp's schema. */
  readonly secretKeys?: readonly string[] | ReadonlySet<string>;
  /** Receives malformed-file and watcher failures without allowing them to escape. */
  readonly onError?: (error: AppFailure) => void;
  /** Defaults to the fs helper's 100ms debounce. */
  readonly watchDebounceMs?: number;
}

export type ConfigChangeListener = (change: ConfigChanged) => void | Promise<void>;

type ConfigReadRequest = Omit<ConfigReadArgs, "folder"> & { readonly folder: string | null };
type ConfigListRequest = { readonly prefix?: string; readonly folder: string | null };
type ConfigWriteRequest = Omit<ConfigWriteArgs, "folder"> & { readonly folder: string | null };

type LayerValues = ReadonlyMap<string, JsonValue>;

interface ParsedYaml {
  readonly document: Document;
  readonly values: LayerValues;
}

interface LayerRead {
  readonly layer: PersistedLayer;
  readonly source: PersistedSource;
  readonly folder: string | null;
  readonly selectedPath: string;
  readonly selected: ParsedYaml;
  readonly selectedSnapshot: FileSnapshot;
  readonly candidates: readonly FileSnapshot[];
}

interface ScopeRead {
  readonly folder: string | null;
  readonly layers: ReadonlyMap<PersistedLayer, LayerRead>;
  readonly revision: string;
}

interface ResolvedSetting {
  readonly source: ConfigSource;
  readonly value: JsonValue;
  readonly path?: string;
  readonly provenanceOrigin: "omp-config" | "app-store" | "host-fallback";
  readonly overrides: SettingSource[];
}

interface LayerCandidate {
  readonly source: ConfigSource;
  readonly values: LayerValues;
  readonly path?: string;
  readonly provenanceOrigin: ResolvedSetting["provenanceOrigin"];
  readonly fallbackEnvironment?: boolean;
}

interface Subscription {
  readonly id: number;
  readonly listener: ConfigChangeListener;
  readonly ready: Promise<void>;
}

interface ScopeState {
  readonly folder: string | null;
  readonly subscriptions: Set<number>;
}

interface WatchedPath {
  readonly path: string;
  readonly layer: PersistedLayer;
  readonly folder: string | null;
  readonly watcher: FileWatcher;
  values: LayerValues;
}

function failure(
  code: "invalid_args" | "conflict" | "not_found" | "permission" | "internal",
  message: string,
  retryable = false,
): AppFailure {
  return new AppFailure({ code, message, retryable });
}

function isAppFailure(error: unknown): error is AppFailure {
  return error instanceof AppFailure;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function toFailure(error: unknown, operation: string): AppFailure {
  if (isAppFailure(error)) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return failure("permission", `Cannot ${operation}: permission denied.`, false);
  }
  if (code === "ENOENT") {
    return failure("not_found", `Cannot ${operation}: file or folder not found.`, false);
  }
  return failure("internal", `Cannot ${operation}.`, false);
}

function reportError(callback: ConfigStoreOptions["onError"], error: unknown): void {
  if (!callback) return;
  const appError = toFailure(error, "read configuration");
  try {
    callback(appError);
  } catch {
    // An error observer must never become an uncaught watcher exception.
  }
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDirectory, value.slice(2));
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}
/**
 * Matches omp v18.6.1's config/settings.ts:659-660 and
 * packages/utils/src/dirs.ts:27-31, 619-625: PI_CODING_AGENT_DIR wins,
 * otherwise OMP_PROFILE selects ~/.omp/profiles/<profile>/agent, otherwise
 * the default is ~/.omp/agent. The native file is config.yml, with
 * config.yaml as the read fallback.
 */
function resolveAgentDirectory(options: ConfigStoreOptions): string {
  const environment = options.env ?? process.env;
  const homeDirectory = resolve(options.homeDir ?? homedir());
  const explicit = nonEmpty(options.agentDir) ?? nonEmpty(environment.PI_CODING_AGENT_DIR);
  if (explicit) return resolve(expandHome(explicit, homeDirectory));
  const profile = nonEmpty(environment.OMP_PROFILE);
  if (profile) return resolve(homeDirectory, ".omp", "profiles", profile, "agent");
  return resolve(homeDirectory, ".omp", "agent");
}

function resolveAppDirectory(options: ConfigStoreOptions): string {
  const environment = options.env ?? process.env;
  const configured = nonEmpty(options.appDataDir) ?? nonEmpty(environment.OMP_APP_DATA_DIR);
  if (configured) return resolve(expandHome(configured, resolve(options.homeDir ?? homedir())));
  return resolve(options.homeDir ?? homedir(), ".omp", "app");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw failure("invalid_args", "Configuration contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (isPlainRecord(value)) {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(value)) result[key] = normalizeJson(child);
    return result;
  }
  throw failure("invalid_args", "Configuration contains a value that is not JSON-compatible.");
}

function collectValues(
  value: JsonValue,
  prefix = "",
  result = new Map<string, JsonValue>(),
): Map<string, JsonValue> {
  if (prefix) result.set(prefix, value);
  if (isPlainRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childKey = prefix ? `${prefix}.${key}` : key;
      collectValues(child, childKey, result);
    }
  }
  return result;
}

function mapValues(input: Readonly<Record<string, unknown>> | undefined): LayerValues {
  if (!input) return new Map();
  const root = normalizeJson(input);
  if (!isPlainRecord(root))
    throw failure("invalid_args", "Configuration layer values must be an object.");
  return collectValues(root);
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (isPlainRecord(value)) {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
    return result;
  }
  return value;
}

function mergeJson(lower: JsonValue, higher: JsonValue): JsonValue {
  if (!isPlainRecord(lower) || !isPlainRecord(higher)) return cloneJson(higher);
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(lower)) result[key] = cloneJson(value);
  for (const [key, value] of Object.entries(higher)) {
    const existing = result[key];
    result[key] = existing === undefined ? cloneJson(value) : mergeJson(existing, value);
  }
  return result;
}

function valuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapEqual(left: LayerValues, right: LayerValues): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!valuesEqual(value, right.get(key))) return false;
  }
  return true;
}

function pathParts(key: string): string[] {
  return key.split(".");
}

function mapKeys(...maps: LayerValues[]): string[] {
  const keys = new Set<string>();
  for (const map of maps) for (const key of map.keys()) keys.add(key);
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function credentialLike(key: string): boolean {
  const segments = key.split(".");
  if (segments.some((segment) => CREDENTIAL_PARENT.test(segment))) return true;
  return segments.some((segment) => CREDENTIAL_SEGMENT.test(segment));
}

/** True when a value, or anything nested in it, is credential-shaped by key or by value. */
function containsSecret(
  value: unknown,
  key: string,
  isSecretKey: (key: string) => boolean,
): boolean {
  if (typeof value === "string")
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some((child) => containsSecret(child, key, isSecretKey));
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([childKey, child]) => {
    const fullKey = key ? `${key}.${childKey}` : childKey;
    return isSecretKey(fullKey) || containsSecret(child, fullKey, isSecretKey);
  });
}

function revisionForSnapshots(snapshots: readonly FileSnapshot[]): string {
  const parts = snapshots
    .map((snapshot) => [snapshot.path, snapshot.hash] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return hashContent(JSON.stringify(parts));
}

function snapshotValues(document: Document, path: string): LayerValues {
  let raw: unknown;
  try {
    if (document.errors.length > 0)
      throw failure("invalid_args", "Configuration file contains malformed YAML.");
    raw = document.toJS({ mapAsMap: false });
  } catch (error) {
    if (isAppFailure(error)) throw error;
    throw failure("invalid_args", "Configuration file contains malformed YAML.");
  }
  if (raw === null || raw === undefined) return new Map();
  let normalized: JsonValue;
  try {
    normalized = normalizeJson(raw);
  } catch (error) {
    if (isAppFailure(error)) throw error;
    throw failure("invalid_args", "Configuration file contains malformed YAML.");
  }
  if (!isPlainRecord(normalized)) {
    throw failure("invalid_args", `Configuration file ${path} must contain a YAML mapping.`);
  }
  return collectValues(normalized);
}

function parseYaml(content: string, path: string): ParsedYaml {
  let document: Document;
  try {
    document = parseDocument(content, { keepSourceTokens: true });
  } catch {
    throw failure("invalid_args", "Configuration file contains malformed YAML.");
  }
  return { document, values: snapshotValues(document, path) };
}

function emptyYaml(): ParsedYaml {
  return parseYaml("", "configuration");
}

function sourceIsSetting(source: ConfigSource): source is SettingSource {
  return source !== "app";
}

export class ConfigStoreService {
  readonly agentDir: string;
  readonly appDataDir: string;

  private readonly options: ConfigStoreOptions;
  private readonly environmentValues: LayerValues;
  private readonly runtimeValues: LayerValues;
  private readonly overlayValues: LayerValues;
  private readonly defaultValues: LayerValues;
  private readonly fallbackEnvironmentKeys: ReadonlySet<string>;
  private readonly secretKeys: ReadonlySet<string>;
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly scopes = new Map<string, ScopeState>();
  private readonly watchedPaths = new Map<string, WatchedPath>();
  private nextSubscriptionId = 1;

  constructor(options: ConfigStoreOptions = {}) {
    this.options = options;
    this.agentDir = resolveAgentDirectory(options);
    this.appDataDir = resolveAppDirectory(options);
    this.environmentValues = mapValues(options.environmentValues);
    this.runtimeValues = mapValues(options.runtimeValues);
    this.overlayValues = mapValues(options.overlayValues);
    this.defaultValues = mapValues(options.defaultValues);
    this.fallbackEnvironmentKeys = new Set(options.fallbackEnvironmentKeys ?? []);
    this.secretKeys = new Set(options.secretKeys ?? []);
  }

  async read(args: ConfigReadRequest): Promise<ConfigEntry> {
    const folder = this.validateFolder(args.folder);
    const scope = await this.readScope(folder);
    return this.entryForKey(args.key, scope);
  }

  async list(args: ConfigListRequest): Promise<ConfigListResult> {
    const folder = this.validateFolder(args.folder);
    const scope = await this.readScope(folder);
    const entries = this.entriesForScope(scope, args.prefix);
    return { entries, revision: scope.revision };
  }

  async write(args: ConfigWriteRequest): Promise<ConfigWriteResult> {
    const folder = this.validateFolder(args.folder);
    this.validateWriteScope(args.layer, folder);
    if (args.layer === "project") await this.requireProjectFolder(folder);

    const initial = await this.readScope(folder);
    const initialTarget = this.targetLayer(initial, args.layer);
    const initialWriteSnapshot = this.canonicalSnapshot(initialTarget);
    this.checkExpectedRevision(args.expectedRevision, initial.revision, initialWriteSnapshot.hash);

    // Re-read immediately before patching. The fs CAS below closes the remaining target-file race.
    const current = await this.readScope(folder);
    const currentTarget = this.targetLayer(current, args.layer);
    const currentWriteSnapshot = this.canonicalSnapshot(currentTarget);
    if (
      current.revision !== initial.revision ||
      currentTarget.selectedSnapshot.hash !== initialTarget.selectedSnapshot.hash ||
      currentWriteSnapshot.hash !== initialWriteSnapshot.hash
    ) {
      throw failure(
        "conflict",
        "Cannot write configuration: it changed while preparing the write.",
        true,
      );
    }

    const document = currentTarget.selected.document;
    const key = args.key;
    // The same rule as reads: a setting the UI was shown as secret can only be set or unset.
    const secret = this.isSecretEntry(key, this.resolveSetting(key, current)?.value);
    if (secret !== args.value.secret) {
      throw failure(
        "invalid_args",
        secret
          ? "Credential settings require a secret write."
          : "This setting is not credential-shaped.",
      );
    }
    try {
      if (args.value.secret) {
        if (args.value.action === "set") document.setIn(pathParts(key), args.value.value);
        else document.deleteIn(pathParts(key));
      } else {
        document.setIn(pathParts(key), args.value.value);
      }
    } catch {
      throw failure("invalid_args", "Cannot patch configuration key.");
    }

    const content = document.toString();
    try {
      await compareAndSwapFile(currentWriteSnapshot.path, content, currentWriteSnapshot.hash);
    } catch (error) {
      throw toFailure(error, "write configuration");
    }

    const after = await this.readScope(folder);
    await this.refreshWatchState(currentWriteSnapshot.path);
    const entry = this.entryForKey(key, after, secret);
    return {
      key,
      layer: args.layer,
      folder,
      revision: after.revision,
      previousRevision: initial.revision,
      entry,
    };
  }

  /** Subscribe to effective changes visible from one folder (`null` is global/app only). */
  subscribe(folder: string | null, listener: ConfigChangeListener): () => void {
    const normalizedFolder = this.validateFolder(folder);
    const id = this.nextSubscriptionId++;
    const key = this.scopeKey(normalizedFolder);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { folder: normalizedFolder, subscriptions: new Set() };
      this.scopes.set(key, scope);
    }
    scope.subscriptions.add(id);
    const ready = this.initializeScope(scope);
    this.subscriptions.set(id, { id, listener, ready });
    this.retainWatchers(normalizedFolder);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.subscriptions.delete(id);
      const current = this.scopes.get(key);
      if (!current) return;
      current.subscriptions.delete(id);
      if (current.subscriptions.size === 0) {
        this.scopes.delete(key);
        this.releaseWatchers(normalizedFolder);
      }
    };
  }

  watch(folder: string | null, listener: ConfigChangeListener): () => void {
    return this.subscribe(folder, listener);
  }

  onChanged(folder: string | null, listener: ConfigChangeListener): () => void {
    return this.subscribe(folder, listener);
  }

  dispose(): void {
    for (const watcher of this.watchedPaths.values()) watcher.watcher.dispose();
    this.watchedPaths.clear();
    this.subscriptions.clear();
    this.scopes.clear();
  }

  private validateFolder(folder: string | null): FolderPath | null {
    if (folder === null) return null;
    if (!FolderPath.safeParse(folder).success)
      throw failure(
        "invalid_args",
        "Project folder must be an absolute path without a trailing separator.",
      );
    return FolderPath.parse(resolve(folder));
  }

  private validateWriteScope(layer: ConfigWriteRequest["layer"], folder: string | null): void {
    if (layer === "project" && folder === null)
      throw failure("invalid_args", "Project writes require a folder.");
    if (layer !== "project" && folder !== null)
      throw failure("invalid_args", "Global and app writes do not accept a project folder.");
  }

  private async requireProjectFolder(folder: string | null): Promise<void> {
    if (!folder) throw failure("invalid_args", "Project writes require a folder.");
    try {
      const metadata = await fs.stat(folder);
      if (!metadata.isDirectory())
        throw failure("invalid_args", "Project folder must be a directory.");
    } catch (error) {
      if (isAppFailure(error)) throw error;
      throw toFailure(error, "write project configuration");
    }
  }

  private isSecretKey(key: string): boolean {
    return this.secretKeys.has(key) || credentialLike(key);
  }

  /** A setting is secret when its key is credential-shaped or its value carries a credential. */
  private isSecretEntry(key: string, value: unknown): boolean {
    return (
      this.isSecretKey(key) ||
      containsSecret(value, key, (candidate) => this.isSecretKey(candidate))
    );
  }

  private scopeKey(folder: string | null): string {
    return folder ?? "<global>";
  }

  private layerPaths(layer: PersistedLayer, folder: string | null): readonly string[] {
    if (layer === "global")
      return [join(this.agentDir, CONFIG_FILE), join(this.agentDir, CONFIG_FALLBACK_FILE)];
    if (layer === "app") return [join(this.appDataDir, APP_CONFIG_FILE)];
    if (!folder) throw failure("invalid_args", "Project configuration requires a folder.");
    return [join(folder, ".omp", CONFIG_FILE)];
  }

  private async readLayer(layer: PersistedLayer, folder: string | null): Promise<LayerRead> {
    const paths = this.layerPaths(layer, folder);
    const candidates: FileSnapshot[] = [];
    for (const path of paths) {
      try {
        candidates.push(await readFileSnapshot(path));
      } catch (error) {
        throw toFailure(error, "read configuration");
      }
    }
    if (candidates.length === 0)
      throw failure("internal", "Configuration layer has no file paths.");
    let selectedIndex = 0;
    const firstCandidate = candidates[0];
    const secondCandidate = candidates[1];
    if (!firstCandidate) throw failure("internal", "Configuration layer has no canonical file.");
    if (!firstCandidate.exists && secondCandidate?.exists) selectedIndex = 1;
    const selectedSnapshot = candidates[selectedIndex];
    if (!selectedSnapshot) throw failure("internal", "Configuration layer selected no file.");
    const selected = selectedSnapshot.exists
      ? parseYaml(selectedSnapshot.content ?? "", selectedSnapshot.path)
      : emptyYaml();
    return {
      layer,
      source: layer,
      folder,
      selectedPath: selectedSnapshot.path,
      selected,
      selectedSnapshot,
      candidates,
    };
  }

  private async readScope(folder: string | null): Promise<ScopeRead> {
    const layerEntries: [PersistedLayer, LayerRead][] = [];
    for (const layer of CONFIG_LAYERS) {
      if (layer === "project" && folder === null) continue;
      layerEntries.push([layer, await this.readLayer(layer, folder)]);
    }
    const layers = new Map(layerEntries);
    const snapshots = layerEntries.flatMap(([, layer]) => layer.candidates);
    return { folder, layers, revision: revisionForSnapshots(snapshots) };
  }

  private targetLayer(scope: ScopeRead, layer: ConfigWriteRequest["layer"]): LayerRead {
    const target = scope.layers.get(layer);
    if (!target) throw failure("invalid_args", "Project configuration requires a folder.");
    return target;
  }
  private canonicalSnapshot(target: LayerRead): FileSnapshot {
    const snapshot = target.candidates[0];
    if (!snapshot) throw failure("internal", "Configuration layer has no canonical file.");
    return snapshot;
  }

  private checkExpectedRevision(
    expected: string | null,
    current: string,
    targetHash: string | null,
  ): void {
    if (expected === null) {
      if (targetHash !== null)
        throw failure(
          "conflict",
          "Cannot write configuration: the target file already exists.",
          true,
        );
      return;
    }
    if (expected !== current && expected !== targetHash) {
      throw failure("conflict", "Cannot write configuration: the file changed.", true);
    }
  }

  private candidatesFor(scope: ScopeRead): readonly LayerCandidate[] {
    const app = scope.layers.get("app");
    const project = scope.layers.get("project");
    const global = scope.layers.get("global");
    const candidates: LayerCandidate[] = [];
    if (app)
      candidates.push({
        source: "app",
        values: app.selected.values,
        path: app.selectedPath,
        provenanceOrigin: "app-store",
      });
    if (this.environmentValues.size > 0) {
      candidates.push({
        source: "env",
        values: this.environmentValues,
        provenanceOrigin: "omp-config",
        fallbackEnvironment: false,
      });
    }
    if (this.runtimeValues.size > 0) {
      candidates.push({
        source: "runtime",
        values: this.runtimeValues,
        provenanceOrigin: "host-fallback",
      });
    }
    if (this.overlayValues.size > 0) {
      candidates.push({
        source: "overlay",
        values: this.overlayValues,
        provenanceOrigin: "omp-config",
      });
    }
    if (project)
      candidates.push({
        source: "project",
        values: project.selected.values,
        path: project.selectedPath,
        provenanceOrigin: "omp-config",
      });
    if (global)
      candidates.push({
        source: "global",
        values: global.selected.values,
        path: global.selectedPath,
        provenanceOrigin: "omp-config",
      });
    if (this.environmentValues.size > 0 && this.fallbackEnvironmentKeys.size > 0) {
      candidates.push({
        source: "env",
        values: this.environmentValues,
        provenanceOrigin: "omp-config",
        fallbackEnvironment: true,
      });
    }
    if (this.defaultValues.size > 0) {
      candidates.push({
        source: "default",
        values: this.defaultValues,
        provenanceOrigin: "host-fallback",
      });
    }
    return candidates;
  }

  private resolveSetting(key: string, scope: ScopeRead): ResolvedSetting | undefined {
    const candidates = this.candidatesFor(scope);
    const configured: { candidate: LayerCandidate; value: JsonValue }[] = [];
    for (const candidate of candidates) {
      if (
        candidate.source === "env" &&
        candidate.fallbackEnvironment !== this.fallbackEnvironmentKeys.has(key)
      ) {
        continue;
      }
      const raw = candidate.values.get(key);
      if (raw === undefined || raw === null) continue;
      configured.push({ candidate, value: raw });
    }
    if (configured.length === 0) return undefined;

    const selected = configured[0];
    if (!selected) return undefined;
    let value = cloneJson(selected.value);
    for (const lower of configured.slice(1)) {
      if (isPlainRecord(value) && isPlainRecord(lower.value)) value = mergeJson(lower.value, value);
      else break;
    }
    const overrides: SettingSource[] = [];
    const seen = new Set<SettingSource>();
    for (const lower of configured.slice(1)) {
      if (!sourceIsSetting(lower.candidate.source) || seen.has(lower.candidate.source)) continue;
      seen.add(lower.candidate.source);
      overrides.push(lower.candidate.source);
    }
    return {
      source: selected.candidate.source,
      value,
      path: selected.candidate.path,
      provenanceOrigin: selected.candidate.provenanceOrigin,
      overrides,
    };
  }

  private provenance(resolved: ResolvedSetting) {
    return {
      origin: resolved.provenanceOrigin,
      ompVersion: OMP_VERSION,
      ...(resolved.path ? { path: resolved.path } : {}),
    } as const;
  }

  /** `knownSecret` keeps a value-detected secret reported as an (unset) secret after it is removed. */
  private entryForKey(key: string, scope: ScopeRead, knownSecret = false): ConfigEntry {
    const resolved = this.resolveSetting(key, scope);
    if (!resolved) {
      if (knownSecret || this.isSecretKey(key)) {
        return {
          key,
          secret: true,
          isSet: false,
          source: "global",
          overrides: [],
          provenance: { origin: "omp-config", ompVersion: OMP_VERSION },
        };
      }
      throw failure("not_found", "Configuration key was not found.");
    }
    const provenance = this.provenance(resolved);
    if (this.isSecretEntry(key, resolved.value)) {
      return {
        key,
        secret: true,
        isSet: true,
        source: resolved.source,
        overrides: resolved.overrides,
        provenance,
      };
    }
    return {
      key,
      secret: false,
      value: resolved.value,
      source: resolved.source,
      overrides: resolved.overrides,
      provenance,
    };
  }

  private entriesForScope(scope: ScopeRead, prefix?: string): ConfigEntry[] {
    const layerValues = [...scope.layers.values()].map((layer) => layer.selected.values);
    const keys = mapKeys(
      this.environmentValues,
      this.runtimeValues,
      this.overlayValues,
      this.defaultValues,
      ...layerValues,
    );
    return keys
      .filter((key) => prefix === undefined || key.startsWith(prefix))
      .map((key) => {
        try {
          return this.entryForKey(key, scope);
        } catch (error) {
          if (isAppFailure(error) && error.appError.code === "not_found") return undefined;
          throw error;
        }
      })
      .filter((entry): entry is ConfigEntry => entry !== undefined);
  }

  private async initializeScope(scope: ScopeState): Promise<void> {
    try {
      await this.readScope(scope.folder);
    } catch (error) {
      reportError(this.options.onError, error);
    }
  }

  private watchedFilePaths(
    folder: string | null,
  ): readonly { path: string; layer: PersistedLayer; folder: string | null }[] {
    const paths: { path: string; layer: PersistedLayer; folder: string | null }[] = [
      ...this.layerPaths("global", null).map((path) => ({
        path,
        layer: "global" as const,
        folder: null,
      })),
      ...this.layerPaths("app", null).map((path) => ({
        path,
        layer: "app" as const,
        folder: null,
      })),
    ];
    if (folder !== null) {
      const projectPath = this.layerPaths("project", folder)[0];
      if (!projectPath) throw failure("internal", "Project configuration has no canonical file.");
      paths.push({ path: projectPath, layer: "project", folder });
    }
    return paths;
  }

  private retainWatchers(folder: string | null): void {
    for (const descriptor of this.watchedFilePaths(folder)) {
      if (this.watchedPaths.has(descriptor.path)) continue;
      const initialValues = new Map<string, JsonValue>();
      void readFileSnapshot(descriptor.path)
        .then((read) => {
          if (!read.exists) return;
          try {
            const values = parseYaml(read.content ?? "", read.path).values;
            const current = this.watchedPaths.get(descriptor.path);
            if (current) current.values = values;
          } catch (error) {
            reportError(this.options.onError, error);
          }
        })
        .catch((error) => reportError(this.options.onError, error));
      try {
        const watcher = watchFile(descriptor.path, () => this.handleFileChange(descriptor), {
          debounceMs: this.options.watchDebounceMs,
          onError: (error) => reportError(this.options.onError, error),
        });
        this.watchedPaths.set(descriptor.path, {
          ...descriptor,
          watcher,
          values: initialValues,
        });
      } catch (error) {
        reportError(this.options.onError, error);
      }
    }
  }

  private releaseWatchers(_folder: string | null): void {
    const needed = new Set(this.watchedFilePathsForAllScopes());
    for (const [path, watched] of this.watchedPaths) {
      if (needed.has(path)) continue;
      watched.watcher.dispose();
      this.watchedPaths.delete(path);
    }
  }

  private watchedFilePathsForAllScopes(): string[] {
    const paths = new Set<string>();
    for (const scope of this.scopes.values())
      for (const descriptor of this.watchedFilePaths(scope.folder)) paths.add(descriptor.path);
    return [...paths];
  }

  private async refreshWatchState(path: string): Promise<void> {
    const watched = this.watchedPaths.get(path);
    if (!watched) return;
    try {
      const snapshot = await readFileSnapshot(path);
      watched.values = snapshot.exists ? parseYaml(snapshot.content ?? "", path).values : new Map();
    } catch (error) {
      reportError(this.options.onError, error);
    }
  }

  private async handleFileChange(descriptor: {
    path: string;
    layer: PersistedLayer;
    folder: string | null;
  }): Promise<void> {
    const watched = this.watchedPaths.get(descriptor.path);
    if (!watched) return;
    let nextValues: LayerValues;
    try {
      const snapshot = await readFileSnapshot(descriptor.path);
      nextValues = snapshot.exists
        ? parseYaml(snapshot.content ?? "", descriptor.path).values
        : new Map();
    } catch (error) {
      reportError(this.options.onError, error);
      return;
    }
    const previousValues = watched.values;
    watched.values = nextValues;
    if (mapEqual(previousValues, nextValues)) return;

    const changedKey = mapKeys(previousValues, nextValues).find(
      (key) => !valuesEqual(previousValues.get(key), nextValues.get(key)),
    );
    if (!changedKey) return;
    if (descriptor.layer === "global") {
      const globalPaths = this.layerPaths("global", null);
      const canonicalPath = globalPaths[0];
      const fallbackPath = globalPaths[1];
      if (descriptor.path === fallbackPath && canonicalPath) {
        const selectedGlobal = (await this.readLayer("global", null)).selectedPath;
        if (selectedGlobal === canonicalPath) return;
      }
    }

    for (const scope of this.scopes.values()) {
      if (descriptor.layer === "project" && scope.folder !== descriptor.folder) continue;
      let read: ScopeRead;
      try {
        read = await this.readScope(scope.folder);
      } catch (error) {
        reportError(this.options.onError, error);
        continue;
      }
      const entry = this.eventEntry(changedKey, read, descriptor.layer);
      const revision = read.revision;
      for (const subscriptionId of scope.subscriptions) {
        const subscription = this.subscriptions.get(subscriptionId);
        if (!subscription) continue;
        try {
          await subscription.ready;
          const change: ConfigChanged = {
            key: changedKey,
            layer: descriptor.layer,
            folder:
              descriptor.layer === "project" ? FolderPath.parse(descriptor.folder ?? "") : null,
            revision,
            entry,
          };
          const result = subscription.listener(change);
          if (result && typeof result === "object" && "then" in result) await result;
        } catch (error) {
          reportError(this.options.onError, error);
        }
      }
    }
  }

  private eventEntry(key: string, scope: ScopeRead, layer: PersistedLayer): ConfigEntry {
    try {
      return this.entryForKey(key, scope);
    } catch (error) {
      if (!isAppFailure(error) || error.appError.code !== "not_found") throw error;
      const source: ConfigSource = layer;
      const path = scope.layers.get(layer)?.selectedPath;
      if (this.isSecretKey(key)) {
        return {
          key,
          secret: true,
          isSet: false,
          source,
          overrides: [],
          provenance: {
            origin: layer === "app" ? "app-store" : "omp-config",
            ompVersion: OMP_VERSION,
            ...(path ? { path } : {}),
          },
        };
      }
      return {
        key,
        secret: false,
        value: null,
        source,
        overrides: [],
        provenance: {
          origin: layer === "app" ? "app-store" : "omp-config",
          ompVersion: OMP_VERSION,
          ...(path ? { path } : {}),
        },
      };
    }
  }
}

export function createConfigStore(options: ConfigStoreOptions = {}): ConfigStoreService {
  return new ConfigStoreService(options);
}

export { ConfigStoreService as ConfigStore, ConfigStoreService as ConfigStoreImpl };
