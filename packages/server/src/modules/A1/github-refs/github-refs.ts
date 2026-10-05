import {
  type AbortSignalLike,
  AppFailure,
  type GithubCurrentPullRequestResult,
  GithubReference,
  type GithubReferenceKind,
  type GithubReferenceSearchArgs,
  type GithubReferenceSearchResult,
} from "@omp-app/contracts";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 8_192;

export interface GithubRefsOptions {
  readonly ghBinary?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

function failure(
  code: "unavailable" | "invalid_args" | "timeout" | "cancelled" | "internal",
  message: string,
  retryable = false,
): AppFailure {
  return new AppFailure({
    code,
    message,
    retryable,
    capability: code === "unavailable" ? "host.github-refs" : undefined,
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function copyEnvironment(overrides: GithubRefsOptions["env"]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (stream === null || stream === undefined || typeof stream === "number") {
    return { text: "", truncated: false };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.floor(value));
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw failure("invalid_args", "GitHub reference limit must be between 1 and 50.");
  }
  return value;
}

function unavailableFromStderr(stderr: string, missing = false): AppFailure {
  const detail = stderr.toLowerCase();
  if (
    missing ||
    detail.includes("not logged in") ||
    detail.includes("authentication") ||
    detail.includes("auth login")
  ) {
    return failure(
      "unavailable",
      missing ? "GitHub CLI (gh) is not available." : "GitHub CLI is not authenticated.",
    );
  }
  return failure("unavailable", "GitHub CLI could not complete the request.", true);
}

async function runGh(
  folder: string,
  args: readonly string[],
  options: GithubRefsOptions,
  signal?: AbortSignalLike,
): Promise<CommandResult> {
  if (signal?.aborted) throw failure("cancelled", "The GitHub request was cancelled.");
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxOutputBytes = Math.max(1, Math.floor(options.maxOutputBytes ?? MAX_OUTPUT_BYTES));
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([options.ghBinary ?? "gh", ...args], {
      cwd: folder,
      env: copyEnvironment(options.env),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw unavailableFromStderr(
      errorCode(error) === "ENOENT" ? "" : "",
      errorCode(error) === "ENOENT",
    );
  }

  let timedOut = false;
  let cancelled = false;
  let killError: unknown;
  const kill = (): void => {
    try {
      child.kill();
    } catch (error) {
      killError = error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  let removeAbort: (() => void) | undefined;
  if (signal) {
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  }
  const stdoutPromise = readBounded(child.stdout, maxOutputBytes);
  const stderrPromise = readBounded(child.stderr, maxOutputBytes);
  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    clearTimeout(timer);
    removeAbort?.();
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (cancelled || signal?.aborted) throw failure("cancelled", "The GitHub request was cancelled.");
  if (timedOut) throw failure("timeout", "The GitHub request timed out.", true);
  if (killError) throw failure("internal", "The GitHub process could not be stopped.");
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function normalizeState(
  value: unknown,
  kind: GithubReferenceKind,
): "open" | "closed" | "merged" | "unknown" {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (normalized === "open") return "open";
  if (kind === "pull-request" && normalized === "merged") return "merged";
  if (normalized === "closed") return "closed";
  return "unknown";
}

function safeBody(value: unknown): { readonly body: string; readonly truncated: boolean } {
  const body = typeof value === "string" ? value : "";
  return { body: body.slice(0, MAX_BODY_CHARS), truncated: body.length > MAX_BODY_CHARS };
}

function parseReference(
  value: unknown,
  kind: GithubReferenceKind,
): { reference: GithubReference; truncated: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure("internal", "GitHub CLI returned invalid reference data.");
  }
  const row = value as Record<string, unknown>;
  const number = typeof row.number === "number" ? row.number : Number.NaN;
  const title = typeof row.title === "string" ? row.title.slice(0, 512) : undefined;
  const url = typeof row.url === "string" ? row.url : undefined;
  if (!Number.isSafeInteger(number) || number < 1 || title === undefined || url === undefined) {
    throw failure("internal", "GitHub CLI returned invalid reference data.");
  }
  const body = safeBody(row.body);
  const repository =
    typeof row.repository === "string"
      ? row.repository
      : typeof row.repository === "object" &&
          row.repository !== null &&
          "nameWithOwner" in row.repository
        ? typeof row.repository.nameWithOwner === "string"
          ? row.repository.nameWithOwner
          : undefined
        : undefined;
  const reference = GithubReference.parse({
    kind,
    number,
    title,
    body: body.body,
    url,
    state: normalizeState(row.state, kind),
    ...(repository ? { repository: repository.slice(0, 256) } : {}),
  });
  return { reference, truncated: body.truncated };
}

function parseSearchOutput(
  stdout: string,
  kind: GithubReferenceKind,
  limit: number,
): GithubReferenceSearchResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw failure("internal", "GitHub CLI returned invalid JSON.");
  }
  if (!Array.isArray(value)) throw failure("internal", "GitHub CLI returned invalid search data.");
  const parsed = value.slice(0, limit).map((item) => parseReference(item, kind));
  return {
    candidates: parsed.map((item) => item.reference),
    truncated: value.length > limit || parsed.some((item) => item.truncated),
  };
}

/** Read-only GitHub references through the user's existing `gh` login. */
export class GithubRefsService {
  readonly #options: GithubRefsOptions;

  constructor(options: GithubRefsOptions = {}) {
    this.#options = options;
  }

  async search(
    args: GithubReferenceSearchArgs,
    signal?: AbortSignalLike,
  ): Promise<GithubReferenceSearchResult> {
    const limit = normalizeLimit(args.limit);
    const kinds: GithubReferenceKind[] =
      args.kind === "all" ? ["issue", "pull-request"] : [args.kind];
    const candidates: GithubReference[] = [];
    let truncated = false;
    for (const kind of kinds) {
      const command = kind === "issue" ? "issues" : "prs";
      const result = await runGh(
        args.folder,
        [
          "search",
          command,
          args.query,
          "--limit",
          String(limit),
          "--json",
          "number,title,body,url,state,repository",
        ],
        this.#options,
        signal,
      );
      if (result.exitCode !== 0) throw unavailableFromStderr(result.stderr);
      if (result.truncated) truncated = true;
      const parsed = parseSearchOutput(result.stdout, kind, limit);
      candidates.push(...parsed.candidates);
      truncated ||= parsed.truncated;
    }
    return {
      candidates: candidates.slice(0, limit),
      truncated: truncated || candidates.length > limit,
    };
  }

  async currentPullRequest(
    args: { readonly folder: string },
    signal?: AbortSignalLike,
  ): Promise<GithubCurrentPullRequestResult> {
    const result = await runGh(
      args.folder,
      ["pr", "view", "--json", "number,title,body,url,state,repository"],
      this.#options,
      signal,
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.toLowerCase();
      if (detail.includes("no pull request") || detail.includes("not found"))
        return { pullRequest: null };
      throw unavailableFromStderr(result.stderr);
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw failure("internal", "GitHub CLI returned invalid JSON.");
    }
    if (value === null) return { pullRequest: null };
    return { pullRequest: parseReference(value, "pull-request").reference };
  }
}

export function createGithubRefs(options: GithubRefsOptions = {}): GithubRefsService {
  return new GithubRefsService(options);
}
