import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileSearchCandidate, FileSearchKind, FileSearchResult } from "@omp-app/contracts";
import { type AbortSignalLike, AppFailure } from "@omp-app/contracts";
import { GIT_SAFE_CONFIG } from "../git/git";

export const DEFAULT_FILE_SEARCH_LIMIT = 50;
export const MAX_FILE_SEARCH_LIMIT = 200;
export const DEFAULT_FILE_SEARCH_SCAN_LIMIT = 10_000;
export const DEFAULT_FILE_SEARCH_SCAN_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FILE_SEARCH_TIMEOUT_MS = 2_000;
const MAX_FILE_SEARCH_TIMEOUT_MS = 60_000;
const MAX_ERROR_BYTES = 64 * 1024;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

const CANDIDATE_CACHE_TTL_MS = 30_000;
const CANDIDATE_CACHE_FOLDERS = 8;
/**
 * Names a walk skips, entry and all: dependency, cache and repository metadata, and `.worktrees`, where git worktrees keep
 * whole copies of a repository. Those copies would fill the results with duplicates of the same files. The Files panel
 * marks the same names `ignored` (#2782).
 */
export const WALK_SKIPPED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".worktrees",
]);
/** Sorts names the way `localeCompare` does; one collator serves every sort. */
const LOCALE_ORDER = new Intl.Collator();

export interface FileSearchOptions {
  readonly signal?: AbortSignalLike;
  readonly timeoutMs?: number;
  /** Maximum number of filesystem or git-list entries inspected in one search. */
  readonly scanLimit?: number;
  /** Maximum bytes read from git's NUL-delimited path list. */
  readonly scanBytes?: number;
  readonly gitBinary?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock for the candidate cache's 30 seconds; the default is `Date.now`. Tests set it. */
  readonly now?: () => number;
}

export type FileSearchRequest = {
  readonly folder: string;
  readonly query: string;
  readonly limit?: number;
};

type SearchKind = Extract<FileSearchKind, "file" | "directory">;

type SearchCandidate = {
  readonly path: string;
  readonly kind: SearchKind;
};

type Collection = {
  readonly candidates: readonly SearchCandidate[];
  readonly truncated: boolean;
};

type FileStat = Stats;

type GitTextResult =
  | {
      readonly kind: "completed";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "spawn-error";
      readonly cause: unknown;
      readonly message: string;
    };

type GitListResult =
  | {
      readonly kind: "completed";
      readonly exitCode: number;
      readonly stderr: string;
      readonly paths: readonly string[];
      readonly truncated: boolean;
    }
  | {
      readonly kind: "spawn-error";
      readonly cause: unknown;
      readonly message: string;
    };

class SearchBudget {
  readonly #signal: AbortSignalLike | undefined;
  readonly #deadline: number;

  constructor(signal: AbortSignalLike | undefined, timeoutMs: number) {
    this.#signal = signal;
    this.#deadline = Date.now() + timeoutMs;
  }

  assert(): void {
    if (this.#signal?.aborted) throw cancelledFailure();
    if (Date.now() >= this.#deadline) throw timeoutFailure();
  }

  remaining(): number {
    this.assert();
    return Math.max(1, this.#deadline - Date.now());
  }

  async wait<T>(operation: PromiseLike<T>): Promise<T> {
    const pending = Promise.resolve(operation);
    // Observe the operation before any early exit below. A stream read still pending when the
    // budget runs out is rejected once its reader's lock is released; left unobserved, that
    // rejection surfaces as an unhandled AbortError instead of this budget's timeout or cancel.
    pending.catch(() => undefined);
    this.assert();
    const promises: Promise<T>[] = [pending];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(timeoutFailure()), this.remaining());
    });
    promises.push(timeoutPromise);

    if (this.#signal !== undefined) {
      let listener: (() => void) | undefined;
      const cancelledPromise = new Promise<T>((_, reject) => {
        listener = () => reject(cancelledFailure());
        this.#signal?.addEventListener("abort", listener, { once: true });
      });
      promises.push(cancelledPromise);
      removeAbortListener = () => {
        if (listener !== undefined) this.#signal?.removeEventListener("abort", listener);
      };
    }

    try {
      return await Promise.race(promises);
    } finally {
      clearTimeout(timer);
      removeAbortListener?.();
    }
  }
}

class ScanBudget {
  readonly #limit: number;
  scanned = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get exhausted(): boolean {
    return this.scanned >= this.#limit;
  }

  take(): boolean {
    if (this.exhausted) {
      this.truncated = true;
      return false;
    }
    this.scanned += 1;
    return true;
  }
}

/** One folder's listing and the time it was cached. */
interface CachedCollection {
  readonly collection: Collection;
  readonly cachedAt: number;
}

/**
 * Listings by folder, keyed with the limits that shape them. A query within 30 seconds ranks against the cached list and
 * reads nothing from disk. Eight folders are kept; the oldest goes first. Map order is the order of caching.
 */
const candidateCache = new Map<string, CachedCollection>();

function candidateKey(
  folder: string,
  scanLimit: number,
  scanBytes: number,
  gitBinary: string | undefined,
): string {
  return [folder, scanLimit, scanBytes, gitBinary ?? ""].join("\0");
}

function cachedCollection(key: string, now: number): Collection | undefined {
  const entry = candidateCache.get(key);
  if (entry === undefined) return undefined;
  if (isFresh(entry, now)) return entry.collection;
  candidateCache.delete(key);
  return undefined;
}

function rememberCollection(key: string, collection: Collection, now: number): void {
  candidateCache.delete(key);
  candidateCache.set(key, { collection, cachedAt: now });
  for (const [cachedKey, entry] of candidateCache) {
    if (!isFresh(entry, now)) candidateCache.delete(cachedKey);
  }
  while (candidateCache.size > CANDIDATE_CACHE_FOLDERS) {
    const oldest = candidateCache.keys().next().value;
    if (oldest === undefined) break;
    candidateCache.delete(oldest);
  }
}

function isFresh(entry: CachedCollection, now: number): boolean {
  const age = now - entry.cachedAt;
  return age >= 0 && age < CANDIDATE_CACHE_TTL_MS;
}

/**
 * Search workspace paths without reading their contents.
 *
 * Git repositories use git's own ignore machinery. Non-repositories use a bounded, symlink-free
 * walk and skip the dependency and repository metadata directories that are not useful mentions.
 */
export async function searchWorkspaceFiles(
  request: FileSearchRequest,
  options: FileSearchOptions = {},
): Promise<FileSearchResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const budget = new SearchBudget(options.signal, timeoutMs);
  try {
    const validated = validateRequest(request);
    const limit = normalizeLimit(request.limit);
    const scanLimit = normalizeScanLimit(options.scanLimit);
    const scanBytes = normalizeScanBytes(options.scanBytes);
    const folder = await validateFolder(validated.folder, budget);
    const clock = options.now ?? Date.now;
    const key = candidateKey(folder, scanLimit, scanBytes, options.gitBinary);
    let collection = cachedCollection(key, clock());
    if (collection === undefined) {
      const scan = new ScanBudget(scanLimit);
      collection =
        (await collectFromGit(folder, budget, scan, scanBytes, options)) ??
        (await collectByWalk(folder, budget, scan));
      rememberCollection(key, collection, clock());
    }
    return rankCandidates(collection, validated.query, limit, budget);
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw toFailure(error);
  }
}

function validateRequest(request: FileSearchRequest): { folder: string; query: string } {
  if (typeof request !== "object" || request === null) {
    throw invalidArgsFailure("A workspace folder and query are required.");
  }
  const folder = request.folder;
  const query = request.query;
  if (
    typeof folder !== "string" ||
    folder.length === 0 ||
    !isAbsolute(folder) ||
    WINDOWS_ABSOLUTE_PATH.test(folder) ||
    folder.includes("\0")
  ) {
    throw invalidArgsFailure("The workspace folder must be an absolute path.");
  }
  if (typeof query !== "string" || query.length > 512 || query.includes("\0")) {
    throw invalidArgsFailure("The file search query is invalid.");
  }
  return { folder, query };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FILE_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILE_SEARCH_LIMIT) {
    throw invalidArgsFailure("The file search limit must be between 1 and 200.");
  }
  return limit;
}

function normalizeScanLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_FILE_SEARCH_SCAN_LIMIT;
  return Math.max(1, Math.min(DEFAULT_FILE_SEARCH_SCAN_LIMIT, Math.floor(limit)));
}

function normalizeScanBytes(bytes: number | undefined): number {
  if (bytes === undefined || !Number.isFinite(bytes)) return DEFAULT_FILE_SEARCH_SCAN_BYTES;
  return Math.max(1, Math.min(DEFAULT_FILE_SEARCH_SCAN_BYTES, Math.floor(bytes)));
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_FILE_SEARCH_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(MAX_FILE_SEARCH_TIMEOUT_MS, Math.floor(timeoutMs)));
}

async function validateFolder(folder: string, budget: SearchBudget): Promise<string> {
  const requested = resolve(folder);
  const info = await budget.wait(lstat(requested));
  if (!info.isDirectory()) {
    throw invalidArgsFailure("The workspace path is not a folder.");
  }
  return budget.wait(realpath(requested));
}

async function collectFromGit(
  folder: string,
  budget: SearchBudget,
  scan: ScanBudget,
  scanBytes: number,
  options: FileSearchOptions,
): Promise<Collection | null> {
  const probe = await runGitText(folder, ["rev-parse", "--show-toplevel"], budget, options);
  if (shouldUseWalk(probe)) return null;
  if (probe.kind === "spawn-error") {
    throw internalFailure("Unable to inspect Git workspace state.", probe.cause);
  }
  if (probe.exitCode !== 0) {
    throw internalFailure(
      "Unable to inspect Git workspace state.",
      gitCause("probe", probe.stderr),
    );
  }

  const rootText = probe.stdout.trim();
  if (rootText.length === 0 || rootText.includes("\0")) {
    throw internalFailure("Unable to inspect Git workspace state.");
  }
  const repositoryRoot = await budget.wait(realpath(resolve(rootText)));
  if (!isInside(repositoryRoot, folder)) return null;
  // Git lists nothing under a folder that the repository ignores, so such a folder is searched as a plain folder (issue 827).
  if (await isIgnoredByRepository(repositoryRoot, folder, budget, options)) return null;

  const listed = await runGitList(folder, budget, scan, scanBytes, options);
  if (shouldUseWalk(listed)) return null;
  if (listed.kind === "spawn-error") {
    throw internalFailure("Unable to list Git workspace paths.", listed.cause);
  }
  if (listed.exitCode !== 0 && !listed.truncated) {
    throw internalFailure("Unable to list Git workspace paths.", gitCause("list", listed.stderr));
  }

  const candidates = new Map<string, SearchKind>();
  for (const listedPath of listed.paths) {
    budget.assert();
    await addGitPath(listedPath, repositoryRoot, folder, candidates, budget);
  }
  return {
    candidates: [...candidates].map(([path, kind]) => ({ path, kind })),
    truncated: listed.truncated || scan.truncated,
  };
}

/**
 * Whether the repository's ignore rules hide this folder. The repository lists nothing under an ignored folder.
 */
async function isIgnoredByRepository(
  repositoryRoot: string,
  folder: string,
  budget: SearchBudget,
  options: FileSearchOptions,
): Promise<boolean> {
  const relativeFolder = relative(repositoryRoot, folder);
  // The repository root itself is never ignored.
  if (!isRelativePath(relativeFolder)) return false;
  const result = await runGitText(
    repositoryRoot,
    ["check-ignore", "--quiet", "--", relativeFolder.split(sep).join("/")],
    budget,
    options,
  );
  return result.kind === "completed" && result.exitCode === 0;
}

function shouldUseWalk(result: GitTextResult | GitListResult): boolean {
  if (result.kind === "spawn-error") {
    return /not found|no such file|enoent/i.test(result.message);
  }
  return (
    result.exitCode === 127 || /not a git repository|outside a repository/i.test(result.stderr)
  );
}

async function addGitPath(
  listedPath: string,
  repositoryRoot: string,
  folder: string,
  candidates: Map<string, SearchKind>,
  budget: SearchBudget,
): Promise<void> {
  if (listedPath.length === 0 || listedPath.includes("\0") || isAbsolute(listedPath)) return;
  const absolute = resolve(repositoryRoot, listedPath);
  if (!isInside(repositoryRoot, absolute)) return;
  const relativeToFolder = relative(folder, absolute);
  if (!isRelativePath(relativeToFolder)) return;
  await addGitPathAsync(absolute, folder, candidates, budget);
}

/**
 * Git paths are processed serially by the caller's event loop. Keeping this helper separate makes
 * the path checks explicit while allowing the asynchronous lstat/realpath operations to be awaited.
 */
async function addGitPathAsync(
  absolute: string,
  folder: string,
  candidates: Map<string, SearchKind>,
  budget: SearchBudget,
): Promise<void> {
  const inspected = await inspectCandidate(absolute, folder, budget);
  if (inspected === null) return;
  candidates.set(inspected.path, inspected.kind);

  let parent = dirname(absolute);
  while (isInside(folder, parent)) {
    budget.assert();
    if (parent === folder) break;
    const parentCandidate = await inspectCandidate(parent, folder, budget);
    if (parentCandidate !== null) candidates.set(parentCandidate.path, parentCandidate.kind);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

interface WalkDirectory {
  readonly absolute: string;
  /** The folder's path from the search folder, "/"-separated; empty for the search folder itself. */
  readonly relative: string;
}

/**
 * Lists a folder that is not a git repository one depth at a time: every folder of a depth, in locale order, before
 * the next depth. The scan limit and the time budget reach a folder's shallow files before a deep dependency tree.
 * Symbolic links are not followed, and every path starts from the folder's real path, so no entry needs its own
 * realpath.
 */
async function collectByWalk(
  folder: string,
  budget: SearchBudget,
  scan: ScanBudget,
): Promise<Collection> {
  const candidates = new Map<string, SearchKind>();
  let level: readonly WalkDirectory[] = [{ absolute: folder, relative: "" }];
  while (level.length > 0 && !scan.truncated) {
    const next: WalkDirectory[] = [];
    for (const directory of level) {
      if (scan.truncated) break;
      budget.assert();
      const entries = await budget.wait(readdir(directory.absolute, { withFileTypes: true }));
      entries.sort((left, right) => LOCALE_ORDER.compare(left.name, right.name));
      for (const entry of entries) {
        budget.assert();
        if (!scan.take()) break;
        if (WALK_SKIPPED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          candidates.set(path, "directory");
          next.push({ absolute: join(directory.absolute, entry.name), relative: path });
        } else if (entry.isFile()) {
          candidates.set(path, "file");
        }
      }
    }
    level = next;
  }
  return {
    candidates: [...candidates].map(([path, kind]) => ({ path, kind })),
    truncated: scan.truncated,
  };
}

async function inspectCandidate(
  absolute: string,
  folder: string,
  budget: SearchBudget,
): Promise<SearchCandidate | null> {
  const info = await tryLstat(absolute, budget);
  if (info === null || info.isSymbolicLink()) return null;
  const actualPath = await tryRealpath(absolute, budget);
  if (actualPath === null || !isInside(folder, actualPath)) return null;
  const path = toRelativePath(folder, actualPath);
  if (path === null) return null;
  const kind: SearchKind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "file";
  if (!info.isDirectory() && !info.isFile()) return null;
  return { path, kind };
}

async function tryLstat(path: string, budget: SearchBudget): Promise<FileStat | null> {
  try {
    return await budget.wait(lstat(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function tryRealpath(path: string, budget: SearchBudget): Promise<string | null> {
  try {
    return await budget.wait(realpath(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function toRelativePath(folder: string, path: string): string | null {
  const candidate = relative(folder, path);
  return isRelativePath(candidate) ? candidate.split(sep).join("/") : null;
}

function isRelativePath(path: string): boolean {
  if (path.length === 0 || path === "." || isAbsolute(path) || WINDOWS_ABSOLUTE_PATH.test(path)) {
    return false;
  }
  return !path.split(/[\\/]/).some((segment) => segment === ".." || segment === ".");
}

function isInside(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate.length === 0 || isRelativePath(candidate);
}

async function runGitText(
  cwd: string,
  args: readonly string[],
  budget: SearchBudget,
  options: FileSearchOptions,
): Promise<GitTextResult> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([options.gitBinary ?? "git", ...GIT_SAFE_CONFIG, ...args], {
      cwd,
      env: processEnvironment(options.env),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      kind: "spawn-error",
      cause: error,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let killFailure: unknown;
  const stop = () => {
    try {
      child.kill();
    } catch (error) {
      killFailure ??= error;
    }
  };
  const stdout = readStreamText(child.stdout, budget, MAX_ERROR_BYTES);
  const stderr = readStreamText(child.stderr, budget, MAX_ERROR_BYTES);
  try {
    const [output, errorOutput, exitCode] = await Promise.all([
      stdout,
      stderr,
      budget.wait(child.exited),
    ]);
    return {
      kind: "completed",
      exitCode,
      stdout: output,
      stderr: errorOutput,
    };
  } catch (error) {
    stop();
    await Promise.allSettled([stdout, stderr, child.exited]);
    if (error instanceof AppFailure) throw error;
    throw internalFailure("Unable to run Git workspace search.", killFailure ?? error);
  }
}

async function runGitList(
  cwd: string,
  budget: SearchBudget,
  scan: ScanBudget,
  scanBytes: number,
  options: FileSearchOptions,
): Promise<GitListResult> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(
      [
        options.gitBinary ?? "git",
        ...GIT_SAFE_CONFIG,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--full-name",
        "-z",
      ],
      {
        cwd,
        env: processEnvironment(options.env),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  } catch (error) {
    return {
      kind: "spawn-error",
      cause: error,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let killFailure: unknown;
  const stop = () => {
    try {
      child.kill();
    } catch (error) {
      killFailure ??= error;
    }
  };
  const paths = readGitPaths(child.stdout, budget, scan, scanBytes, stop);
  const stderr = readStreamText(child.stderr, budget, MAX_ERROR_BYTES);
  try {
    const [pathOutput, errorOutput, exitCode] = await Promise.all([
      paths,
      stderr,
      budget.wait(child.exited),
    ]);
    return {
      kind: "completed",
      exitCode,
      stderr: errorOutput,
      paths: pathOutput.paths,
      truncated: pathOutput.truncated,
    };
  } catch (error) {
    stop();
    await Promise.allSettled([paths, stderr, child.exited]);
    if (error instanceof AppFailure) throw error;
    throw internalFailure("Unable to run Git workspace search.", killFailure ?? error);
  }
}

function processEnvironment(overrides: FileSearchOptions["env"]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

async function readStreamText(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  budget: SearchBudget,
  maxBytes: number,
): Promise<string> {
  if (stream === null || stream === undefined || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await budget.wait(reader.read());
      if (result.done) break;
      if (result.value === undefined) continue;
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const chunk =
          result.value.byteLength > remaining ? result.value.subarray(0, remaining) : result.value;
        chunks.push(decoder.decode(chunk, { stream: true }));
        bytes += chunk.byteLength;
      }
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function readGitPaths(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  budget: SearchBudget,
  scan: ScanBudget,
  maxBytes: number,
  stop: () => void,
): Promise<{ paths: readonly string[]; truncated: boolean }> {
  if (stream === null || stream === undefined || typeof stream === "number") {
    return { paths: [], truncated: false };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const paths: string[] = [];
  let pending = "";
  let bytes = 0;
  let truncated = false;

  const appendPath = (path: string): boolean => {
    if (path.length === 0) return true;
    if (!scan.take()) {
      truncated = true;
      stop();
      return false;
    }
    paths.push(path);
    if (scan.exhausted) {
      truncated = true;
      stop();
      return false;
    }
    return true;
  };

  try {
    while (!truncated) {
      const result = await budget.wait(reader.read());
      if (result.done) break;
      if (result.value === undefined) continue;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        truncated = true;
        scan.truncated = true;
        stop();
        break;
      }
      pending += decoder.decode(result.value, { stream: true });
      let start = 0;
      for (let index = 0; index < pending.length; index += 1) {
        if (pending.charCodeAt(index) !== 0) continue;
        if (!appendPath(pending.slice(start, index))) return { paths, truncated };
        start = index + 1;
      }
      pending = pending.slice(start);
    }
    if (!truncated) {
      const tail = pending + decoder.decode();
      if (tail.length > 0) appendPath(tail);
    }
    return { paths, truncated };
  } finally {
    reader.releaseLock();
  }
}

function rankCandidates(
  collection: Collection,
  query: string,
  limit: number,
  budget: SearchBudget,
): FileSearchResult {
  const terms = normalizeQuery(query);
  const ranked: Array<FileSearchCandidate & { readonly order: number }> = [];
  let order = 0;
  for (const candidate of collection.candidates) {
    budget.assert();
    const score = scorePath(candidate.path, terms);
    if (score === null) continue;
    ranked.push({ ...candidate, score, order });
    order += 1;
  }
  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : left.order - right.order;
  });
  return {
    results: ranked.slice(0, limit).map(({ order: _order, ...candidate }) => candidate),
    truncated: collection.truncated,
  };
}

function normalizeQuery(query: string): readonly string[] {
  return query
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim().toLocaleLowerCase())
    .filter((segment) => segment.length > 0);
}

function scorePath(path: string, terms: readonly string[]): number | null {
  if (terms.length === 0) return 0;
  const segments = path.toLocaleLowerCase().split("/");
  let score = 0;
  let previousSegment = -1;
  for (const term of terms) {
    let best: { score: number; index: number } | undefined;
    for (let index = 0; index < segments.length; index += 1) {
      const segmentScore = scoreSegment(term, segments[index] ?? "");
      if (segmentScore === null) continue;
      const positionBonus = index === segments.length - 1 ? 110 : 0;
      const continuityBonus = index === previousSegment + 1 ? 35 : 0;
      const candidate = { score: segmentScore + positionBonus + continuityBonus, index };
      if (best === undefined || candidate.score > best.score) best = candidate;
    }
    if (best === undefined) return null;
    score += best.score;
    previousSegment = best.index;
  }

  const normalizedPath = segments.join("/");
  const normalizedQuery = terms.join("/");
  if (normalizedPath === normalizedQuery) score += 500;
  else if (normalizedPath.startsWith(normalizedQuery)) score += 180;
  score -= Math.max(0, segments.length - 1) * 3;
  score -= Math.max(0, path.length - normalizedQuery.length) * 0.05;
  return Math.max(0, score);
}

function scoreSegment(query: string, segment: string): number | null {
  if (segment === query) return 1_000;
  if (segment.startsWith(query)) return 850 - (segment.length - query.length) * 2;
  const substring = segment.indexOf(query);
  if (substring >= 0) return 700 - substring * 4 - (segment.length - query.length);

  let cursor = 0;
  let gaps = 0;
  let previous = -1;
  for (const character of query) {
    const found = segment.indexOf(character, cursor);
    if (found < 0) return null;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    cursor = found + 1;
  }
  return 450 + (query.length / Math.max(query.length, segment.length)) * 100 - gaps * 6;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function toFailure(error: unknown): AppFailure {
  const code = errorCode(error);
  if (code === "ENOENT")
    return new AppFailure({
      code: "not_found",
      message: "The workspace folder was not found.",
      retryable: false,
    });
  if (code === "EACCES" || code === "EPERM") {
    return new AppFailure({
      code: "permission",
      message: "The workspace cannot be read.",
      retryable: false,
    });
  }
  return internalFailure("Unable to search workspace files.", error);
}

function gitCause(operation: string, stderr: string): Error {
  const detail = stderr.trim();
  return new Error(detail.length > 0 ? `${operation}: ${detail}` : `${operation} failed`);
}

function invalidArgsFailure(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function timeoutFailure(): AppFailure {
  return new AppFailure({
    code: "timeout",
    message: "The workspace file search timed out.",
    retryable: true,
  });
}

function cancelledFailure(): AppFailure {
  return new AppFailure({
    code: "cancelled",
    message: "The workspace file search was cancelled.",
    retryable: false,
  });
}

function internalFailure(message: string, cause?: unknown): AppFailure {
  return cause === undefined
    ? new AppFailure({ code: "internal", message, retryable: false })
    : new AppFailure({ code: "internal", message, retryable: false }, { cause });
}
