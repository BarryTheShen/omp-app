import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  AppFailure,
  FolderPath,
  type Rule,
  type RuleChanged,
  type RuleDeleteArgs,
  type RuleDeleteResult,
  type RuleListArgs,
  type RuleListResult,
  RuleName,
  type RuleReadArgs,
  type RuleScope,
  type RuleWriteArgs,
  type RuleWriteResult,
} from "@omp-app/contracts";
import { type Document, parseDocument } from "yaml";
import {
  compareAndSwapFile,
  type FileSnapshot,
  type FileWatcher,
  type FileWatchRegistry,
  hashContent,
  readFileSnapshot,
  watchFile,
} from "../fs";

const RULES_DIRECTORY = "rules";
const STICKY_RULE_NAME = "RULES.md";
const RULE_EXTENSIONS = new Set([".md", ".mdc"]);

export interface RuleStoreOptions {
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly agentDir?: string;
  readonly onError?: (error: AppFailure) => void;
  readonly watchDebounceMs?: number;
  /** Records the watched files this store cannot watch right now, so the person can be told. */
  readonly watchRegistry?: FileWatchRegistry;
}

export type RuleChangeListener = (change: RuleChanged) => void | Promise<void>;

interface RuleLocation {
  readonly folder: string | null;
  readonly scope: RuleScope;
  readonly source: Rule["source"];
  readonly directory: string;
  readonly stickyPath: string;
}

interface ParsedRuleFile {
  readonly content: string;
  readonly enabled: boolean;
  readonly document: Document | null;
}

interface RuleFile {
  readonly id: Rule["id"];
  readonly path: string;
  readonly snapshot: FileSnapshot;
  readonly parsed: ParsedRuleFile;
}

interface ScopeSnapshot {
  readonly location: RuleLocation;
  readonly files: readonly RuleFile[];
  readonly revision: string;
}

interface ScopeWatcher {
  readonly location: RuleLocation;
  readonly listeners: Set<number>;
  readonly subscriptions: Map<number, RuleChangeListener>;
  readonly watchers: Map<string, FileWatcher>;
  files: Map<string, string | null>;
  revision: string;
  ready?: Promise<void>;
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
  const value = error.code;
  return typeof value === "string" ? value : undefined;
}

function toFailure(error: unknown, operation: string): AppFailure {
  if (isAppFailure(error)) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return failure("permission", `Cannot ${operation}: permission denied.`, false);
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return failure("not_found", `Cannot ${operation}: rule file not found.`, false);
  }
  return failure("internal", `Cannot ${operation}.`, false);
}

function reportError(callback: RuleStoreOptions["onError"], error: unknown): void {
  if (!callback) return;
  const appError = toFailure(error, "read rule files");
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

function resolveAgentDirectory(options: RuleStoreOptions): string {
  const environment = options.env ?? process.env;
  const homeDirectory = resolve(options.homeDir ?? homedir());
  const explicit = nonEmpty(options.agentDir) ?? nonEmpty(environment.PI_CODING_AGENT_DIR);
  if (explicit) return resolve(expandHome(explicit, homeDirectory));
  const profile = nonEmpty(environment.OMP_PROFILE);
  if (profile) return resolve(homeDirectory, ".omp", "profiles", profile, "agent");
  return resolve(homeDirectory, ".omp", "agent");
}

function normalizeFolder(folder: string | null, scope: RuleScope): string | null {
  if (scope === "global") {
    if (folder !== null)
      throw failure("invalid_args", "Global rules do not accept a project folder.");
    return null;
  }
  if (folder === null || !FolderPath.safeParse(folder).success) {
    throw failure("invalid_args", "Project rules require an absolute project folder.");
  }
  return resolve(folder);
}

function normalizeName(name: string): RuleName {
  const parsed = RuleName.safeParse(name);
  if (!parsed.success || basename(name) !== name || name.includes("\\") || name.includes("..")) {
    throw failure("invalid_args", "Rule name must be a simple .md or .mdc filename.");
  }
  return parsed.data;
}

function pathForRule(location: RuleLocation, id: string): string {
  const name = normalizeName(id);
  if (name === STICKY_RULE_NAME) return location.stickyPath;
  const path = resolve(location.directory, name);
  const within = relative(location.directory, path);
  if (within !== name || within.startsWith("..") || within.includes("/")) {
    throw failure("invalid_args", "Rule name resolves outside the native rule folder.");
  }
  return path;
}

function ruleLocation(
  options: RuleStoreOptions,
  scope: RuleScope,
  folder: string | null,
): RuleLocation {
  const normalizedFolder = normalizeFolder(folder, scope);
  if (scope === "global") {
    const directory = resolve(resolveAgentDirectory(options), RULES_DIRECTORY);
    return {
      folder: null,
      scope,
      source: "agent",
      directory,
      stickyPath: resolve(dirname(directory), STICKY_RULE_NAME),
    };
  }
  const projectRoot = normalizedFolder as string;
  const directory = resolve(projectRoot, ".omp", RULES_DIRECTORY);
  return {
    folder: projectRoot,
    scope,
    source: "project",
    directory,
    stickyPath: resolve(projectRoot, ".omp", STICKY_RULE_NAME),
  };
}

function ruleIdFromPath(path: string): RuleName {
  return normalizeName(basename(path));
}

function ruleName(id: RuleName): string {
  return id.slice(0, -extname(id).length);
}

function parseRuleContent(content: string): ParsedRuleFile {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { content, enabled: true, document: null };
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) throw failure("invalid_args", "Rule file frontmatter is unterminated.");
  let document: Document;
  try {
    document = parseDocument(lines.slice(1, closing).join("\n"));
  } catch {
    throw failure("invalid_args", "Rule file frontmatter is malformed.", false);
  }
  if (document.errors.length > 0) {
    throw failure("invalid_args", "Rule file frontmatter is malformed.");
  }
  const value = document.toJS({ mapAsMap: false });
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw failure("invalid_args", "Rule file frontmatter must be a mapping.");
  }
  const enabled =
    typeof value === "object" && value !== null && "enabled" in value
      ? (value as Record<string, unknown>).enabled !== false
      : true;
  return { content: lines.slice(closing + 1).join("\n"), enabled, document };
}

function serializeRule(parsed: ParsedRuleFile | null, content: string, enabled: boolean): string {
  if (!parsed?.document) {
    return enabled ? content : `---\nenabled: false\n---\n${content}`;
  }
  parsed.document.set("enabled", enabled);
  return `---\n${parsed.document.toString().trimEnd()}\n---\n${content}`;
}

function fileRevision(snapshot: FileSnapshot): string {
  return snapshot.hash ?? hashContent("");
}

function scopeRevision(files: readonly RuleFile[]): string {
  const entries = files.map((file) => `${file.id}\0${file.snapshot.hash ?? ""}`).sort();
  return hashContent(JSON.stringify(entries));
}

function scopeKey(location: RuleLocation): string {
  return `${location.scope}:${location.folder ?? "global"}`;
}

function changedId(path: string): RuleName {
  return ruleIdFromPath(path);
}

/**
 * Native omp rule files. Locations and Markdown/frontmatter semantics follow omp v18.6.1's
 * `discovery/builtin.ts:388-446` and `discovery/helpers.ts:230-278`: user rules are
 * `<agentDir>/rules/*.{md,mdc}` plus `<agentDir>/RULES.md`; project rules are nearest
 * `<folder>/.omp/rules/*.{md,mdc}` plus `<folder>/.omp/RULES.md`. All mutations stay in those
 * directories and publish through A1.2's atomic CAS writer.
 */
export class RuleStoreService {
  readonly agentDir: string;
  readonly #options: RuleStoreOptions;
  readonly #scopes = new Map<string, ScopeWatcher>();
  #nextSubscriptionId = 1;

  constructor(options: RuleStoreOptions = {}) {
    this.#options = options;
    this.agentDir = resolveAgentDirectory(options);
  }

  async list(args: RuleListArgs): Promise<RuleListResult> {
    const snapshot = await this.readScope(args.scope, args.folder);
    return {
      rules: snapshot.files.map((file) => this.ruleFromFile(snapshot.location, file)),
      revision: snapshot.revision,
    };
  }

  async read(args: RuleReadArgs): Promise<Rule> {
    const snapshot = await this.readScope(args.scope, args.folder);
    const id = normalizeName(args.id);
    const file = snapshot.files.find((candidate) => candidate.id === id);
    if (!file) throw failure("not_found", "Rule file was not found.");
    return this.ruleFromFile(snapshot.location, file);
  }

  async write(args: RuleWriteArgs): Promise<RuleWriteResult> {
    const location = ruleLocation(this.#options, args.scope, args.folder);
    const id = normalizeName(args.id);
    const path = pathForRule(location, id);
    const before = await this.readScope(args.scope, args.folder);
    const target = before.files.find((file) => file.id === id);
    this.checkExpectedRevision(
      args.expectedRevision,
      before.revision,
      target?.snapshot.hash ?? null,
      target !== undefined,
    );
    const content = serializeRule(target?.parsed ?? null, args.content, args.enabled);
    try {
      await compareAndSwapFile(path, content, target?.snapshot.hash ?? null);
    } catch (error) {
      throw toFailure(error, "write rule file");
    }
    const after = await this.readScope(args.scope, args.folder);
    const written = after.files.find((file) => file.id === id);
    if (!written) throw failure("internal", "Rule file disappeared after writing.");
    await this.refreshScope(location, false);
    return {
      rule: this.ruleFromFile(after.location, written),
      revision: after.revision,
      previousRevision: before.revision,
    };
  }

  async delete(args: RuleDeleteArgs): Promise<RuleDeleteResult> {
    const location = ruleLocation(this.#options, args.scope, args.folder);
    const id = normalizeName(args.id);
    const path = pathForRule(location, id);
    const before = await this.readScope(args.scope, args.folder);
    const target = before.files.find((file) => file.id === id);
    if (!target) throw failure("not_found", "Rule file was not found.");
    if (args.expectedRevision !== before.revision) {
      throw failure("conflict", "Rule files changed; reload before deleting.", true);
    }
    try {
      await fs.unlink(path);
    } catch (error) {
      throw toFailure(error, "delete rule file");
    }
    const after = await this.readScope(args.scope, args.folder);
    await this.refreshScope(location, false);
    return { deleted: true, revision: after.revision };
  }

  subscribe(
    scopeRequest: { readonly scope: RuleScope; readonly folder: string | null },
    listener: RuleChangeListener,
  ): () => void {
    const location = ruleLocation(this.#options, scopeRequest.scope, scopeRequest.folder);
    const key = scopeKey(location);
    const id = this.#nextSubscriptionId++;
    let scope = this.#scopes.get(key);
    if (!scope) {
      scope = {
        location,
        listeners: new Set(),
        subscriptions: new Map(),
        watchers: new Map(),
        files: new Map(),
        revision: hashContent("[]"),
      };
      this.#scopes.set(key, scope);
      scope.ready = this.initializeScope(scope);
    }
    scope.listeners.add(id);
    scope.subscriptions.set(id, listener);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.removeSubscription(key, id);
    };
  }

  dispose(): void {
    for (const scope of this.#scopes.values()) {
      for (const watcher of scope.watchers.values()) watcher.dispose();
    }
    this.#scopes.clear();
  }

  private removeSubscription(key: string, id: number): void {
    const scope = this.#scopes.get(key);
    if (!scope) return;
    scope.listeners.delete(id);
    scope.subscriptions.delete(id);
    if (scope.listeners.size !== 0) return;
    for (const watcher of scope.watchers.values()) watcher.dispose();
    this.#scopes.delete(key);
  }

  private async readScope(scope: RuleScope, folder: string | null): Promise<ScopeSnapshot> {
    const location = ruleLocation(this.#options, scope, folder);
    let entries: string[] = [];
    try {
      const dirents = await fs.readdir(location.directory, { withFileTypes: true });
      entries = dirents
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name !== STICKY_RULE_NAME &&
            RULE_EXTENSIONS.has(extname(entry.name)),
        )
        .map((entry) => entry.name);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw toFailure(error, "list rule files");
    }
    if (await this.exists(location.stickyPath)) entries.push(STICKY_RULE_NAME);
    const unique = [...new Set(entries)].sort();
    const files: RuleFile[] = [];
    for (const entry of unique) {
      const path = entry === STICKY_RULE_NAME ? location.stickyPath : pathForRule(location, entry);
      const snapshot = await this.readSnapshot(path);
      if (!snapshot.exists) continue;
      const parsed = parseRuleContent(snapshot.content ?? "");
      files.push({ id: ruleIdFromPath(path), path, snapshot, parsed });
    }
    return { location, files, revision: scopeRevision(files) };
  }

  private async readSnapshot(path: string): Promise<FileSnapshot> {
    try {
      return await readFileSnapshot(path);
    } catch (error) {
      throw toFailure(error, "read rule file");
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fs.stat(path);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw toFailure(error, "read rule file");
    }
  }

  /**
   * A rule is on or off as its file says. A RULES.md with `enabled: false` is off: omp skips it (omp v18.8.9
   * `discovery/helpers.ts:276`, loaded for RULES.md by `discovery/builtin.ts` `loadStickyRulesFile`).
   */
  private ruleFromFile(location: RuleLocation, file: RuleFile): Rule {
    return {
      id: file.id,
      name: ruleName(file.id),
      scope: location.scope,
      content: file.parsed.content,
      enabled: file.parsed.enabled,
      source: location.source,
      revision: fileRevision(file.snapshot),
    };
  }

  private checkExpectedRevision(
    expected: string | null,
    current: string,
    targetHash: string | null,
    targetExists: boolean,
  ): void {
    if (expected === null) {
      if (targetExists)
        throw failure("conflict", "Rule file already exists; reload before creating.", true);
      return;
    }
    if (expected !== current && expected !== targetHash) {
      throw failure("conflict", "Rule files changed; reload before writing.", true);
    }
  }

  private async initializeScope(scope: ScopeWatcher): Promise<void> {
    try {
      await this.refreshScope(scope.location, false);
    } catch (error) {
      reportError(this.#options.onError, error);
    }
  }

  private async refreshScope(location: RuleLocation, emit: boolean): Promise<void> {
    const scope = this.#scopes.get(scopeKey(location));
    const snapshot = await this.readScope(location.scope, location.folder);
    if (!scope) return;
    const previous = scope.files;
    scope.files = new Map(snapshot.files.map((file) => [file.path, file.snapshot.hash]));
    for (const watcher of scope.watchers.values()) watcher.dispose();
    scope.watchers.clear();
    for (const file of snapshot.files) {
      scope.watchers.set(
        file.path,
        watchFile(file.path, () => this.handleFileChange(scope), {
          debounceMs: this.#options.watchDebounceMs,
          onError: (error) => reportError(this.#options.onError, error),
          registry: this.#options.watchRegistry,
        }),
      );
    }
    const changed = [...new Set([...previous.keys(), ...scope.files.keys()])].filter(
      (path) => previous.get(path) !== scope.files.get(path),
    );
    const shouldEmit = emit && changed.length > 0;
    scope.revision = snapshot.revision;
    if (!shouldEmit) return;
    for (const path of changed) {
      const id = changedId(path);
      await this.emit(scope, {
        folder: scope.location.folder as RuleChanged["folder"],
        scope: scope.location.scope,
        id,
        revision: snapshot.revision,
        reason: "filesystem",
      });
    }
  }

  private async handleFileChange(scope: ScopeWatcher): Promise<void> {
    try {
      await this.refreshScope(scope.location, true);
    } catch (error) {
      reportError(this.#options.onError, error);
    }
  }

  private async emit(scope: ScopeWatcher, change: RuleChanged): Promise<void> {
    for (const id of scope.listeners) {
      const listener = scope.subscriptions.get(id);
      if (!listener) continue;
      try {
        await listener(change);
      } catch (error) {
        reportError(this.#options.onError, error);
      }
    }
  }
}

export function createRuleStore(options: RuleStoreOptions = {}): RuleStoreService {
  return new RuleStoreService(options);
}
