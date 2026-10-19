import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import {
  AppFailure,
  type CommandMetadata,
  type ExtensionCatalogChanged,
  type ExtensionCatalogResult,
  type ExtensionSource,
  type ExtensionSummary,
  FolderPath,
} from "@omp-app/contracts";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  type FileSnapshot,
  type FileWatcher,
  type FileWatchRegistry,
  hashContent,
  readFileSnapshot,
  watchFile,
} from "../fs";

const EXTENSION_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);
const MANIFEST_KEYS = ["extensions", "tools", "hooks", "commands", "skills"] as const;
const MAX_TEXT = 2_000;

export interface ExtensionCatalogOptions {
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly agentDir?: string;
  /** Optional A1.8-backed `/reload-plugins` operation; discovery remains read-only here. */
  readonly reload?: (folder: string | null) => void | Promise<void>;
  readonly watchDebounceMs?: number;
  /** Records the watched files this store cannot watch right now, so the person can be told. */
  readonly watchRegistry?: FileWatchRegistry;
  readonly onError?: (error: AppFailure) => void;
}

export type ExtensionCatalogChangeListener = (
  change: ExtensionCatalogChanged,
) => void | Promise<void>;

type FolderRequest = string | null;
type CatalogReason = ExtensionCatalogChanged["reason"];

interface RootSpec {
  readonly root: string;
  readonly source: ExtensionSource;
  readonly provider: string;
  readonly scope: "user" | "project";
}
interface MarketplacePluginBinding {
  readonly marketplacePluginId: string;
  readonly marketplaceScope: "user" | "project";
  readonly enabled: boolean;
}
function marketplacePluginId(value: string): string | undefined {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1 || value.length > 128) return undefined;
  const segment = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
  const name = value.slice(0, separator);
  const marketplace = value.slice(separator + 1);
  return name.length <= 64 &&
    marketplace.length <= 64 &&
    segment.test(name) &&
    segment.test(marketplace)
    ? value
    : undefined;
}

interface ScanResult {
  readonly catalog: ExtensionCatalogResult;
  readonly files: ReadonlyMap<string, string | null>;
}

interface ScopeSubscription {
  readonly folder: string | null;
  readonly listeners: Set<number>;
  readonly watchers: Map<string, FileWatcher>;
  revision?: string;
  refresh?: Promise<void>;
}

interface Subscription {
  readonly id: number;
  readonly key: string;
  readonly listener: ExtensionCatalogChangeListener;
}

type JsonObject = Record<string, unknown>;

function failure(
  code: "invalid_args" | "permission" | "internal",
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

/** The catalog's own failure for a folder it cannot read: one plain sentence, the cause kept for the debug log. */
function catalogFailure(error: unknown): AppFailure {
  const denied = errorCode(error) === "EACCES" || errorCode(error) === "EPERM";
  return new AppFailure(
    {
      code: denied ? "permission" : "internal",
      message: "Unable to read the installed extensions.",
      retryable: true,
    },
    { cause: error },
  );
}

function reportError(callback: ExtensionCatalogOptions["onError"], error: unknown): void {
  if (!callback) return;
  const appError = isAppFailure(error) ? error : catalogFailure(error);
  try {
    callback(appError);
  } catch {
    // Error observers must never become uncaught filesystem exceptions.
  }
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * omp v18.9.1 `packages/utils/src/dirs.ts` resolves native extensions/skills
 * under the agent directory, marketplace plugins under `getPluginsDir()`, and
 * project providers under `.omp`.
 */
function resolveAgentDir(options: ExtensionCatalogOptions): string {
  const environment = options.env ?? process.env;
  const home = resolve(options.homeDir ?? environment.HOME ?? homedir());
  const explicit = nonEmpty(options.agentDir) ?? nonEmpty(environment.PI_CODING_AGENT_DIR);
  if (explicit) return resolve(expandHome(explicit, home));
  const profile = nonEmpty(environment.OMP_PROFILE);
  if (profile) return resolve(home, ".omp", "profiles", profile, "agent");
  return resolve(home, ".omp", "agent");
}

/**
 * omp v18.9.1 dirs.ts:getPluginsDir resolves the user plugin registry under the
 * configuration root's plugins directory, independently of PI_CODING_AGENT_DIR.
 */
function resolveOmpRoot(options: ExtensionCatalogOptions): string {
  const environment = options.env ?? process.env;
  const home = resolve(options.homeDir ?? environment.HOME ?? homedir());
  const configDir = nonEmpty(environment.PI_CONFIG_DIR) ?? ".omp";
  const profile = nonEmpty(environment.PI_PROFILE) ?? nonEmpty(environment.OMP_PROFILE);
  const profilePath = profile ? ["profiles", profile] : [];
  let root = resolve(home, configDir, ...profilePath);
  const agentDir = resolveAgentDir(options);
  if (agentDir !== resolve(root, "agent")) return root;
  if (process.platform !== "linux" && process.platform !== "darwin") return root;
  const xdgDataHome = nonEmpty(environment.XDG_DATA_HOME);
  if (!xdgDataHome) return root;
  const xdgRoot = resolve(xdgDataHome, "omp", ...profilePath);
  if (existsSync(xdgRoot)) root = xdgRoot;
  return root;
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, MAX_TEXT) : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function objectFrom(value: unknown): JsonObject | undefined {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function relativePath(filePath: string, ompRoot: string): string {
  const value = relative(ompRoot, resolve(filePath)).split(sep).join("/");
  return value.length > 0 && !value.startsWith("../") && value !== ".."
    ? value
    : basename(filePath);
}

function catalogKey(summary: ExtensionSummary): string {
  return `${summary.source}:${summary.id}`;
}

function brokenSummary(
  id: string,
  name: string,
  spec: RootSpec,
  path: string,
  error: string,
): ExtensionSummary {
  return {
    id: safeText(id) ?? "broken",
    name: safeText(name) ?? "broken",
    provider: safeText(spec.provider) ?? "unknown",
    source: spec.source,
    enabled: false,
    shadowed: false,
    capabilities: [],
    path,
    error,
  };
}

function manifestCapabilities(manifest: JsonObject): string[] {
  return MANIFEST_KEYS.filter((key) => {
    const value = manifest[key];
    return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0;
  });
}

function commandMetadata(
  manifest: JsonObject,
  spec: RootSpec,
  packagePath: string,
  enabled: boolean,
  description?: string,
  ompRoot?: string,
): CommandMetadata[] {
  const commands = stringList(manifest.commands);
  return commands.map((entry) => ({
    name: safeText(basename(entry, extname(entry))) ?? "command",
    provider: safeText(spec.provider) ?? "unknown",
    source: spec.source,
    path: relativePath(join(packagePath, entry), ompRoot ?? packagePath),
    ...(description ? { description } : {}),
    enabled,
  }));
}

/** Plugin package manifests use package.json's `omp` or `pi` object, as defined by omp v18.6.1
 * `extensibility/plugins/types.ts` and loaded by `extensibility/plugins/loader.ts`. */
function packageSummary(
  pkg: JsonObject,
  manifest: JsonObject,
  spec: RootSpec,
  packagePath: string,
  ompRoot: string,
  enabled: boolean,
  marketplaceBinding?: MarketplacePluginBinding,
): ExtensionSummary {
  const packageName = safeText(pkg.name) ?? safeText(manifest.name) ?? basename(packagePath);
  const description = safeText(manifest.description) ?? safeText(pkg.description);
  const version = safeText(pkg.version) ?? safeText(manifest.version);
  return {
    id: packageName,
    name: packageName,
    provider: safeText(spec.provider) ?? packageName,
    source: spec.source,
    ...(version ? { version } : {}),
    ...(marketplaceBinding ? { marketplacePluginId: marketplaceBinding.marketplacePluginId } : {}),
    ...(spec.source === "plugin"
      ? { marketplaceScope: marketplaceBinding?.marketplaceScope ?? spec.scope }
      : {}),
    enabled,
    shadowed: false,
    capabilities: manifestCapabilities(manifest),
    path: relativePath(packagePath, ompRoot),
    ...(description ? { description } : {}),
  };
}
async function readJson(
  path: string,
): Promise<{ value?: JsonObject; hash: string | null; error?: string }> {
  let snapshot: FileSnapshot;
  try {
    snapshot = await readFileSnapshot(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { hash: null };
    return { hash: null, error: "Unable to read manifest." };
  }
  if (!snapshot.exists) return { hash: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.content ?? "");
  } catch {
    return { hash: snapshot.hash, error: "Malformed JSON manifest." };
  }
  const value = objectFrom(parsed);
  return value
    ? { value, hash: snapshot.hash }
    : { hash: snapshot.hash, error: "Manifest must be a JSON object." };
}

async function readText(
  path: string,
): Promise<{ text?: string; hash: string | null; error?: string }> {
  try {
    const snapshot = await readFileSnapshot(path);
    if (!snapshot.exists) return { hash: null };
    return { text: snapshot.content ?? "", hash: snapshot.hash };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { hash: null };
    return { hash: null, error: "Unable to read metadata file." };
  }
}

async function listChildren(path: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.map((entry) => join(path, entry.name)).sort();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw catalogFailure(error);
  }
}

/** Skills follow omp v18.6.1's non-recursive `<root>/skills/<name>/SKILL.md` layout and YAML
 * frontmatter (`docs/skills.md`, `discovery/builtin.ts:288-315`). */
function parseFrontmatter(text: string): { fields?: JsonObject; error?: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { error: "Skill metadata frontmatter is missing." };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { error: "Skill metadata frontmatter is unterminated." };
  try {
    const document = parseDocument(lines.slice(1, end).join("\n"));
    if (document.errors.length > 0) return { error: "Skill metadata frontmatter is malformed." };
    const fields = objectFrom(document.toJS({ mapAsMap: false }));
    return fields ? { fields } : { error: "Skill metadata frontmatter must be a mapping." };
  } catch {
    return { error: "Skill metadata frontmatter is malformed." };
  }
}

export class ExtensionCatalogService {
  readonly agentDir: string;
  readonly ompRoot: string;
  readonly #options: ExtensionCatalogOptions;
  readonly #subscriptions = new Map<number, Subscription>();
  readonly #scopes = new Map<string, ScopeSubscription>();
  #nextSubscriptionId = 1;

  constructor(options: ExtensionCatalogOptions = {}) {
    this.#options = options;
    this.agentDir = resolveAgentDir(options);
    this.ompRoot = resolveOmpRoot(options);
  }

  async list(args: { readonly folder: FolderRequest }): Promise<ExtensionCatalogResult> {
    const folder = this.validateFolder(args.folder);
    return (await this.scan(folder)).catalog;
  }

  async reload(args: { readonly folder: FolderRequest }): Promise<ExtensionCatalogResult> {
    const folder = this.validateFolder(args.folder);
    if (this.#options.reload) await this.#options.reload(folder);
    const result = await this.scan(folder);
    await this.publish(folder, result, "reload", true);
    return result.catalog;
  }

  subscribe(folder: FolderRequest, listener: ExtensionCatalogChangeListener): () => void {
    const normalizedFolder = this.validateFolder(folder);
    const key = this.scopeKey(normalizedFolder);
    const id = this.#nextSubscriptionId++;
    let scope = this.#scopes.get(key);
    if (!scope) {
      scope = { folder: normalizedFolder, listeners: new Set(), watchers: new Map() };
      this.#scopes.set(key, scope);
      void this.initializeScope(key, scope);
    }
    scope.listeners.add(id);
    this.#subscriptions.set(id, { id, key, listener });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.#subscriptions.delete(id);
      const current = this.#scopes.get(key);
      if (!current) return;
      current.listeners.delete(id);
      if (current.listeners.size === 0) {
        for (const watcher of current.watchers.values()) watcher.dispose();
        this.#scopes.delete(key);
      }
    };
  }

  onChanged(folder: FolderRequest, listener: ExtensionCatalogChangeListener): () => void {
    return this.subscribe(folder, listener);
  }

  /** Called by A0/R0 when omp emits an available-commands/catalog invalidation frame. */
  async notifyOmpChanged(folder: FolderRequest): Promise<ExtensionCatalogResult> {
    const normalizedFolder = this.validateFolder(folder);
    const result = await this.scan(normalizedFolder);
    await this.publish(normalizedFolder, result, "omp", true);
    return result.catalog;
  }

  dispose(): void {
    for (const scope of this.#scopes.values()) {
      for (const watcher of scope.watchers.values()) watcher.dispose();
    }
    this.#scopes.clear();
    this.#subscriptions.clear();
  }

  private validateFolder(folder: FolderRequest): string | null {
    if (folder === null) return null;
    if (!FolderPath.safeParse(folder).success) {
      throw failure("invalid_args", "Extension catalog folder must be an absolute path.");
    }
    return resolve(folder);
  }

  private scopeKey(folder: string | null): string {
    return folder ?? "<global>";
  }

  private roots(folder: string | null): RootSpec[] {
    const roots: RootSpec[] = [
      {
        root: join(this.agentDir, "extensions"),
        source: "extension",
        provider: "native",
        scope: "user",
      },
      { root: join(this.agentDir, "skills"), source: "skill", provider: "native", scope: "user" },
      {
        root: join(this.agentDir, "managed-skills"),
        source: "skill",
        provider: "omp-managed",
        scope: "user",
      },
      {
        root: join(this.ompRoot, "plugins"),
        source: "plugin",
        provider: "omp-plugins",
        scope: "user",
      },
    ];
    if (folder !== null) {
      const projectRoot = join(folder, ".omp");
      roots.push(
        {
          root: join(projectRoot, "extensions"),
          source: "extension",
          provider: "native",
          scope: "project",
        },
        {
          root: join(projectRoot, "skills"),
          source: "skill",
          provider: "native",
          scope: "project",
        },
        {
          root: join(projectRoot, "plugins"),
          source: "plugin",
          provider: "omp-plugins",
          scope: "project",
        },
      );
    }
    return roots;
  }

  private async scan(folder: string | null): Promise<ScanResult> {
    const files = new Map<string, string | null>();
    const summaries: ExtensionSummary[] = [];
    const commands: CommandMetadata[] = [];
    for (const root of this.roots(folder)) {
      if (root.source === "plugin") {
        const result = await this.scanPluginRoot(root, files);
        summaries.push(...result.extensions, ...result.skills);
        commands.push(...result.commands);
      } else if (root.source === "skill") {
        summaries.push(...(await this.scanSkillsRoot(root, files)));
      } else {
        const result = await this.scanExtensionRoot(root, files);
        summaries.push(...result.extensions, ...result.skills);
        commands.push(...result.commands);
      }
    }

    const merged: ExtensionSummary[] = [];
    const lastByKey = new Map<string, number>();
    for (const summary of summaries) {
      const key = catalogKey(summary);
      const previousIndex = lastByKey.get(key);
      if (previousIndex !== undefined && summary.path !== merged[previousIndex]?.path) {
        const previous = merged[previousIndex];
        if (previous) merged[previousIndex] = { ...previous, shadowed: true };
      }
      lastByKey.set(key, merged.length);
      merged.push(summary);
    }
    const extensions = merged.sort((left, right) =>
      `${left.source}:${left.id}:${left.path}`.localeCompare(
        `${right.source}:${right.id}:${right.path}`,
      ),
    );
    commands.sort((left, right) =>
      `${left.name}:${left.path}`.localeCompare(`${right.name}:${right.path}`),
    );
    const revision = hashContent(
      JSON.stringify({
        extensions,
        commands,
        files: [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
      }),
    );
    return { catalog: { revision, extensions, commands }, files };
  }

  private async scanExtensionRoot(
    spec: RootSpec,
    files: Map<string, string | null>,
  ): Promise<{
    extensions: ExtensionSummary[];
    commands: CommandMetadata[];
    skills: ExtensionSummary[];
  }> {
    const extensions: ExtensionSummary[] = [];
    const commands: CommandMetadata[] = [];
    const skills: ExtensionSummary[] = [];
    const children = await listChildren(spec.root);
    for (const child of children) {
      const childName = basename(child);
      const extensionPath = relativePath(child, this.ompRoot);
      if ((await this.isDirectory(child)) === false) {
        if (!EXTENSION_FILE_EXTENSIONS.has(extname(child))) continue;
        const read = await readText(child);
        files.set(child, read.hash);
        extensions.push({
          id: childName,
          name: childName,
          provider: spec.provider,
          source: spec.source,
          enabled: true,
          shadowed: false,
          capabilities: ["extension"],
          path: extensionPath,
          ...(read.error ? { error: read.error, enabled: false } : {}),
        });
        continue;
      }
      const result = await this.scanPackageDirectory(child, spec, files);
      if (result) {
        extensions.push(result.extension);
        commands.push(...result.commands);
        skills.push(...result.skills);
      } else {
        extensions.push({
          id: childName,
          name: childName,
          provider: spec.provider,
          source: spec.source,
          enabled: true,
          shadowed: false,
          capabilities: ["extension"],
          path: extensionPath,
        });
      }
    }
    return { extensions, commands, skills };
  }

  private async scanPackageDirectory(
    packagePath: string,
    spec: RootSpec,
    files: Map<string, string | null>,
    marketplaceBinding?: MarketplacePluginBinding,
  ): Promise<{
    extension: ExtensionSummary;
    commands: CommandMetadata[];
    skills: ExtensionSummary[];
  } | null> {
    const manifestPath = join(packagePath, "package.json");
    const read = await readJson(manifestPath);
    files.set(manifestPath, read.hash);
    if (read.error) {
      return {
        extension: brokenSummary(
          basename(packagePath),
          basename(packagePath),
          spec,
          relativePath(packagePath, this.ompRoot),
          read.error,
        ),
        commands: [],
        skills: [],
      };
    }
    if (!read.value) return null;
    const manifest = objectFrom(read.value.omp) ?? objectFrom(read.value.pi);
    if (!manifest) return null;
    const extension = packageSummary(
      read.value,
      manifest,
      spec,
      packagePath,
      this.ompRoot,
      true,
      marketplaceBinding,
    );
    const commands = commandMetadata(
      manifest,
      spec,
      packagePath,
      extension.enabled,
      extension.description,
      this.ompRoot,
    );
    const skillsPath = join(packagePath, "skills");
    const pluginSkills = await this.scanSkillsRoot(
      { root: skillsPath, source: "plugin", provider: extension.id, scope: spec.scope },
      files,
    );
    return { extension, commands, skills: pluginSkills };
  }

  private async scanPluginRoot(
    spec: RootSpec,
    files: Map<string, string | null>,
  ): Promise<{
    extensions: ExtensionSummary[];
    commands: CommandMetadata[];
    skills: ExtensionSummary[];
  }> {
    const extensions: ExtensionSummary[] = [];
    const commands: CommandMetadata[] = [];
    const skills: ExtensionSummary[] = [];
    const packageRoot = spec.root;
    const packageRead = await readJson(join(packageRoot, "package.json"));
    files.set(join(packageRoot, "package.json"), packageRead.hash);
    const lockRead = await readJson(join(packageRoot, "omp-plugins.lock.json"));
    files.set(join(packageRoot, "omp-plugins.lock.json"), lockRead.hash);
    // omp v18.9.1 registry.ts:getInstalledPluginsRegistryPath/readInstalledPluginsRegistry
    // reads <pluginsDir>/installed_plugins.json with plugins keyed by marketplace plugin ID;
    // types.ts:InstalledPluginEntry carries installPath, scope, and enabled.
    const installedRegistryPath = join(packageRoot, "installed_plugins.json");
    const installedRegistryRead = await readJson(installedRegistryPath);
    files.set(installedRegistryPath, installedRegistryRead.hash);
    const registryPlugins = objectFrom(installedRegistryRead.value?.plugins);
    const bindingsByInstallPath = new Map<string, MarketplacePluginBinding[]>();
    for (const [rawMarketplacePluginId, rawEntries] of Object.entries(registryPlugins ?? {})) {
      const installedMarketplacePluginId = marketplacePluginId(rawMarketplacePluginId);
      if (!installedMarketplacePluginId || !Array.isArray(rawEntries)) continue;
      for (const rawEntry of rawEntries) {
        const installedEntry = objectFrom(rawEntry);
        if (
          !installedEntry ||
          installedEntry.scope !== spec.scope ||
          typeof installedEntry.installPath !== "string"
        )
          continue;
        let installPath: string;
        try {
          installPath = await fs.realpath(installedEntry.installPath);
        } catch {
          continue;
        }
        const bindings = bindingsByInstallPath.get(installPath) ?? [];
        bindings.push({
          marketplacePluginId: installedMarketplacePluginId,
          marketplaceScope: spec.scope,
          enabled: installedEntry.enabled !== false,
        });
        bindingsByInstallPath.set(installPath, bindings);
      }
    }
    const packageNames = new Set<string>();
    if (packageRead.value) {
      const dependencies = objectFrom(packageRead.value.dependencies);
      for (const name of Object.keys(dependencies ?? {})) packageNames.add(name);
    }
    if (lockRead.value) {
      const plugins = objectFrom(lockRead.value.plugins);
      for (const name of Object.keys(plugins ?? {})) packageNames.add(name);
    }
    for (const name of [...packageNames].sort()) {
      const packagePath = join(packageRoot, "node_modules", name);
      let packageRealPath: string | undefined;
      try {
        packageRealPath = await fs.realpath(packagePath);
      } catch {
        packageRealPath = undefined;
      }
      const matchingBindings =
        packageRealPath === undefined ? [] : (bindingsByInstallPath.get(packageRealPath) ?? []);
      const marketplaceBinding = matchingBindings.length === 1 ? matchingBindings[0] : undefined;
      const result = await this.scanPackageDirectory(
        packagePath,
        { ...spec, provider: name },
        files,
        marketplaceBinding,
      );
      if (!result) continue;
      const lockPlugin = objectFrom(objectFrom(lockRead.value?.plugins)?.[name]);
      const enabled = marketplaceBinding
        ? marketplaceBinding.enabled
        : lockPlugin?.enabled !== false;
      extensions.push({ ...result.extension, enabled });
      commands.push(...result.commands.map((command) => ({ ...command, enabled })));
      skills.push(...result.skills.map((skill) => ({ ...skill, enabled })));
    }
    return { extensions, commands, skills };
  }

  private async scanSkillsRoot(
    spec: RootSpec,
    files: Map<string, string | null>,
  ): Promise<ExtensionSummary[]> {
    const summaries: ExtensionSummary[] = [];
    for (const child of await listChildren(spec.root)) {
      if (!(await this.isDirectory(child))) continue;
      const skillPath = join(child, "SKILL.md");
      const read = await readText(skillPath);
      files.set(skillPath, read.hash);
      const name = basename(child);
      const path = relativePath(child, this.ompRoot);
      if (read.error) {
        summaries.push(brokenSummary(name, name, spec, path, read.error));
        continue;
      }
      if (read.text === undefined) continue;
      const frontmatter = parseFrontmatter(read.text);
      if (frontmatter.error) {
        summaries.push(brokenSummary(name, name, spec, path, frontmatter.error));
        continue;
      }
      const fields = frontmatter.fields ?? {};
      const skillName = safeText(fields.name) ?? name;
      const description = safeText(fields.description);
      if (!description) {
        summaries.push(
          brokenSummary(skillName, skillName, spec, path, "Skill description is missing."),
        );
        continue;
      }
      summaries.push({
        id: skillName,
        name: skillName,
        provider: spec.provider,
        source: "skill",
        enabled: fields.enabled !== false,
        shadowed: false,
        capabilities: ["skill"],
        path,
        description,
      });
    }
    return summaries;
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await fs.stat(path)).isDirectory();
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw catalogFailure(error);
    }
  }

  private async initializeScope(key: string, scope: ScopeSubscription): Promise<void> {
    try {
      const result = await this.scan(scope.folder);
      if (this.#scopes.get(key) !== scope) return;
      scope.revision = result.catalog.revision;
      this.armWatchers(scope, result.files);
    } catch (error) {
      reportError(this.#options.onError, error);
    }
  }

  private armWatchers(scope: ScopeSubscription, files: ReadonlyMap<string, string | null>): void {
    for (const watcher of scope.watchers.values()) watcher.dispose();
    scope.watchers.clear();
    for (const path of files.keys()) {
      try {
        scope.watchers.set(
          path,
          watchFile(path, () => this.scheduleRefresh(scope), {
            debounceMs: this.#options.watchDebounceMs,
            onError: (error) => reportError(this.#options.onError, error),
            registry: this.#options.watchRegistry,
          }),
        );
      } catch (error) {
        reportError(this.#options.onError, error);
      }
    }
  }

  private scheduleRefresh(scope: ScopeSubscription): void {
    if (scope.refresh) return;
    scope.refresh = this.refreshScope(scope).finally(() => {
      scope.refresh = undefined;
    });
  }

  private async refreshScope(scope: ScopeSubscription): Promise<void> {
    try {
      const result = await this.scan(scope.folder);
      this.armWatchers(scope, result.files);
      if (result.catalog.revision === scope.revision) return;
      scope.revision = result.catalog.revision;
      await this.emitChanged(scope, { revision: result.catalog.revision, reason: "filesystem" });
    } catch (error) {
      reportError(this.#options.onError, error);
    }
  }

  private async publish(
    folder: string | null,
    result: ScanResult,
    reason: CatalogReason,
    force: boolean,
  ): Promise<void> {
    const scope = this.#scopes.get(this.scopeKey(folder));
    if (!scope) return;
    this.armWatchers(scope, result.files);
    if (!force && scope.revision === result.catalog.revision) return;
    scope.revision = result.catalog.revision;
    await this.emitChanged(scope, { revision: result.catalog.revision, reason });
  }

  private async emitChanged(
    scope: ScopeSubscription,
    change: ExtensionCatalogChanged,
  ): Promise<void> {
    for (const id of scope.listeners) {
      const subscription = this.#subscriptions.get(id);
      if (!subscription) continue;
      try {
        await subscription.listener(change);
      } catch (error) {
        reportError(this.#options.onError, error);
      }
    }
  }
}

export function createExtensionCatalog(
  options: ExtensionCatalogOptions = {},
): ExtensionCatalogService {
  return new ExtensionCatalogService(options);
}
