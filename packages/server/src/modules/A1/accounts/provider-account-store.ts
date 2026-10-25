import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AppError,
  AppFailure,
  type ProviderAccountActionArgs,
  type ProviderAccountLogoutResult,
  type ProviderAccountPinArgs,
  type ProviderAccountPinResult,
  type ProviderAccountResetResult,
  type ProviderAccountsListArgs,
  type ProviderAccountsListResult,
  type ProviderCredentialKind,
  type ProviderListResult,
  type RedactedProvider,
  type RedactedProviderAccount,
} from "@omp-app/contracts";

const AGENT_DB_FILENAME = "agent.db";
const BUSY_TIMEOUT_MS = 5_000;
const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
const SESSION_STICKY_TTL_SEC = 30 * 24 * 60 * 60;
const CAPABILITY = "host.provider-accounts" as const;

export interface ProviderAccountStoreOptions {
  /** Environment used when resolving omp's agent directory. */
  readonly env?: Record<string, string | undefined>;
  /** Home directory used when `PI_CODING_AGENT_DIR` and `OMP_PROFILE` are absent. */
  readonly homeDir?: string;
  /** Explicit omp agent directory; useful for tests and isolated hosts. */
  readonly agentDir?: string;
  /** Explicit agent.db path; useful for temp-database tests. */
  readonly dbPath?: string;
}

interface CredentialRow {
  readonly id: number;
  readonly provider: string;
  readonly credential_type: string;
  readonly data: string;
  readonly disabled_cause: string | null;
}

interface ParsedCredential {
  readonly kind: ProviderCredentialKind | null;
  readonly email?: string;
  readonly expiresAt?: string;
}

function failure(
  code: AppError["code"],
  message: string,
  retryable = false,
  capability?: AppError["capability"],
): AppFailure {
  return new AppFailure({ code, message, retryable, ...(capability ? { capability } : {}) });
}

function unavailable(message: string): AppFailure {
  return failure("unavailable", message, false, CAPABILITY);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = error.code;
  return typeof value === "string" ? value : undefined;
}

function toFailure(error: unknown, operation: string): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = errorCode(error);
  const detail = (error instanceof Error ? error.message : "").toLowerCase();
  if (code === "EACCES" || code === "EPERM" || code === "SQLITE_CANTOPEN") {
    return failure("permission", `Cannot ${operation}: permission denied.`, false);
  }
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    code === "SQLITE_BUSY_RECOVERY"
  ) {
    return failure("conflict", `Cannot ${operation}: the credential store is busy.`, true);
  }
  if (detail.includes("no such table") || detail.includes("malformed")) {
    return unavailable("The omp credential store schema is unavailable.");
  }
  return failure("internal", `Cannot ${operation}.`, false);
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDirectory, value.slice(2));
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Matches omp v18.12.6's `getAgentDir()` resolution used by `getAgentDbPath()` (`packages/utils/src/dirs.ts:640-643, 953-955`). */
function resolveAgentDirectory(options: ProviderAccountStoreOptions): string {
  const environment = options.env ?? process.env;
  const homeDirectory = resolve(options.homeDir ?? homedir());
  const explicit = nonEmpty(options.agentDir) ?? nonEmpty(environment.PI_CODING_AGENT_DIR);
  if (explicit) return resolve(expandHome(explicit, homeDirectory));
  const profile = nonEmpty(environment.OMP_PROFILE);
  if (profile) return resolve(homeDirectory, ".omp", "profiles", profile, "agent");
  return resolve(homeDirectory, ".omp", "agent");
}

function accountOpaqueId(provider: string, id: number): string {
  return `acct-${createHash("sha256").update(`${provider}\0${id}`).digest("hex").slice(0, 24)}`;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function safeEmail(value: unknown): string | undefined {
  const email = safeString(value);
  if (!email || email.includes("\n") || email.includes("\r") || email.length > 320)
    return undefined;
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1 || email.indexOf("@", at + 1) !== -1) return undefined;
  return email;
}

function safeExpiry(value: unknown): string | undefined {
  const milliseconds =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseCredential(row: CredentialRow): ParsedCredential {
  if (row.credential_type === "api_key") return { kind: "api_key" };
  if (row.credential_type !== "oauth") return { kind: null };
  let value: unknown;
  try {
    value = JSON.parse(row.data);
  } catch {
    return { kind: "oauth" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "oauth" };
  }
  const record = value as Record<string, unknown>;
  return {
    kind: "oauth",
    email: safeEmail(record.email),
    expiresAt: safeExpiry(record.expiresAt ?? record.expires_at),
  };
}

function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return undefined;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

function providerName(providerId: string): string {
  const knownNames: Readonly<Record<string, string>> = {
    anthropic: "Anthropic",
    "openai-codex": "OpenAI Codex",
    openai: "OpenAI",
    google: "Google",
    github: "GitHub",
  };
  return knownNames[providerId] ?? providerId;
}

function parseRows(rows: unknown[]): CredentialRow[] {
  const parsed: CredentialRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      throw unavailable("The omp credential store contains malformed account metadata.");
    }
    const value = row as Record<string, unknown>;
    if (
      typeof value.id !== "number" ||
      !Number.isInteger(value.id) ||
      value.id <= 0 ||
      typeof value.provider !== "string" ||
      value.provider.length === 0 ||
      typeof value.credential_type !== "string" ||
      typeof value.data !== "string" ||
      (value.disabled_cause !== null && typeof value.disabled_cause !== "string")
    ) {
      throw unavailable("The omp credential store contains malformed account metadata.");
    }
    parsed.push({
      id: value.id as number,
      provider: value.provider as string,
      credential_type: value.credential_type as string,
      data: value.data as string,
      disabled_cause: value.disabled_cause as string | null,
    });
  }
  return parsed;
}

function queryRows(db: Database, providerId?: string): CredentialRow[] {
  const query = providerId
    ? db.query(
        "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
      )
    : db.query(
        "SELECT id, provider, credential_type, data, disabled_cause FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
      );
  return parseRows(providerId ? query.all(providerId) : query.all());
}

function stickyCacheKey(providerId: string, sessionId: string): string {
  return `${SESSION_STICKY_CACHE_PREFIX}${providerId}:${sessionId}`;
}

function readStickyCredentialId(
  db: Database,
  providerId: string,
  sessionId: string,
): number | undefined {
  try {
    const row = db
      .query(
        "SELECT value FROM cache WHERE key = ? AND expires_at > CAST(strftime('%s','now') AS INTEGER)",
      )
      .get(stickyCacheKey(providerId, sessionId)) as { value?: unknown } | null;
    if (typeof row?.value !== "string") return undefined;
    const value = JSON.parse(row.value) as Record<string, unknown>;
    return typeof value.credentialId === "number" && Number.isInteger(value.credentialId)
      ? value.credentialId
      : undefined;
  } catch (error) {
    const detail = (error instanceof Error ? error.message : "").toLowerCase();
    if (detail.includes("no such table")) return undefined;
    throw error;
  }
}

function accountLabel(credential: ParsedCredential): string {
  const masked = maskEmail(credential.email);
  if (masked) return masked;
  if (credential.kind === "oauth") return "OAuth account";
  if (credential.kind === "api_key") return "API key";
  return "Stored account";
}

function accountSource(credential: ParsedCredential): RedactedProviderAccount["source"] {
  return credential.kind === "oauth" ? "oauth" : "agent-db";
}

function accountDto(
  row: CredentialRow,
  sessionCredentialId: number | undefined,
): RedactedProviderAccount {
  const credential = parseCredential(row);
  return {
    id: accountOpaqueId(row.provider, row.id),
    providerId: row.provider,
    label: accountLabel(credential),
    active: credential.kind === "oauth" && row.id === sessionCredentialId,
    source: accountSource(credential),
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
  };
}

function providerDto(providerId: string, rows: readonly CredentialRow[]): RedactedProvider {
  const kinds: ProviderCredentialKind[] = [];
  for (const row of rows) {
    const kind = parseCredential(row).kind;
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  const source = kinds.length === 1 && kinds[0] === "oauth" ? "oauth" : "agent-db";
  return {
    id: providerId,
    name: providerName(providerId),
    available: true,
    authenticated: rows.length > 0,
    credentialKinds: kinds,
    source,
  };
}

function findAccount(
  rows: readonly CredentialRow[],
  providerId: string,
  accountId: string,
): CredentialRow {
  const row = rows.find((candidate) => accountOpaqueId(providerId, candidate.id) === accountId);
  if (!row) throw failure("not_found", "Provider account was not found.");
  return row;
}

/**
 * Server-only provider/account seam over omp's documented v18.12.6 agent.db format.
 *
 * The upstream store uses SQLite transactions plus a bounded `busy_timeout` for cross-process
 * locking (`packages/ai/src/auth/sqlite-credential-store.ts:620-626, 1327-1457`). Logout soft-deletes
 * `auth_credentials` (`:483-500, 1550-1597`). Session affinity pinning writes the documented
 * `cache` row that `auth/affinity.ts` reads and writes (`:11-13, 160-215, 219-285, 355-368`); no credential
 * bytes are copied into that row or returned from this class. omp 18.12.6 spends a saved usage reset
 * with `/usage reset` and `omp usage reset` (`slash-commands/builtin-session.ts:43-69, 393-418`,
 * `cli/usage-cli.ts:1512`), which call the providers' live APIs and change no credential row. The app
 * does not offer that, so resetUsage reports an explicit unavailable capability instead of claiming a
 * local reset succeeded.
 */
export class ProviderAccountStoreService {
  readonly agentDir: string;
  readonly dbPath: string;

  constructor(options: ProviderAccountStoreOptions = {}) {
    this.agentDir = resolveAgentDirectory(options);
    this.dbPath = resolve(options.dbPath ?? join(this.agentDir, AGENT_DB_FILENAME));
  }

  async listProviders(): Promise<ProviderListResult> {
    const db = this.openDatabase("read");
    if (!db) return { providers: [] };
    try {
      const rows = queryRows(db);
      const grouped = new Map<string, CredentialRow[]>();
      for (const row of rows) {
        const providerRows = grouped.get(row.provider) ?? [];
        providerRows.push(row);
        grouped.set(row.provider, providerRows);
      }
      return {
        providers: [...grouped].map(([providerId, providerRows]) =>
          providerDto(providerId, providerRows),
        ),
      };
    } catch (error) {
      throw toFailure(error, "list provider accounts");
    } finally {
      db.close();
    }
  }

  async listAccounts(args: ProviderAccountsListArgs): Promise<ProviderAccountsListResult> {
    const db = this.openDatabase("read");
    if (!db) return { providerId: args.providerId, accounts: [] };
    try {
      const rows = queryRows(db, args.providerId);
      const sessionCredentialId = args.sessionId
        ? readStickyCredentialId(db, args.providerId, args.sessionId)
        : undefined;
      return {
        providerId: args.providerId,
        accounts: rows.map((row) => accountDto(row, sessionCredentialId)),
      };
    } catch (error) {
      throw toFailure(error, "list provider accounts");
    } finally {
      db.close();
    }
  }

  async logout(args: ProviderAccountActionArgs): Promise<ProviderAccountLogoutResult> {
    const db = this.requireDatabase("write");
    try {
      const transaction = db.transaction(() => {
        const row = findAccount(queryRows(db, args.providerId), args.providerId, args.accountId);
        const updatedRows = db
          .query(
            "UPDATE auth_credentials SET disabled_cause = ?, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ? AND provider = ? AND disabled_cause IS NULL RETURNING id",
          )
          .all("deleted by user", row.id, args.providerId) as Array<{ id: number }>;
        if (updatedRows.length !== 1 || updatedRows[0]?.id !== row.id) {
          throw failure(
            "conflict",
            "Provider account changed before logout; reload and retry.",
            true,
          );
        }
      });
      transaction();
      return { providerId: args.providerId, accountId: args.accountId, removed: true };
    } catch (error) {
      throw toFailure(error, "log out provider account");
    } finally {
      db.close();
    }
  }

  async pin(args: ProviderAccountPinArgs): Promise<ProviderAccountPinResult> {
    const db = this.requireDatabase("write");
    try {
      const transaction = db.transaction(() => {
        const rows = queryRows(db, args.providerId);
        const row = findAccount(rows, args.providerId, args.accountId);
        if (parseCredential(row).kind !== "oauth") {
          throw unavailable("Only stored OAuth accounts can be pinned to a session.");
        }
        const index = rows.findIndex((candidate) => candidate.id === row.id);
        const nowMs = Date.now();
        const value = JSON.stringify({
          type: "oauth",
          index,
          credentialId: row.id,
          lastUsedAtMs: nowMs,
          explicit: true,
        });
        db.query(
          "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        ).run(
          stickyCacheKey(args.providerId, args.sessionId),
          value,
          Math.floor(nowMs / 1000) + SESSION_STICKY_TTL_SEC,
        );
      });
      transaction();
      return {
        sessionId: args.sessionId,
        providerId: args.providerId,
        accountId: args.accountId,
        pinned: true,
      };
    } catch (error) {
      throw toFailure(error, "pin provider account");
    } finally {
      db.close();
    }
  }

  async resetUsage(args: ProviderAccountActionArgs): Promise<ProviderAccountResetResult> {
    const db = this.requireDatabase("read");
    try {
      findAccount(queryRows(db, args.providerId), args.providerId, args.accountId);
    } catch (error) {
      throw toFailure(error, "find provider account for usage reset");
    } finally {
      db.close();
    }
    // The typed command works in the app (it asks first and names the account, #1272), so the reason points there.
    throw unavailable(
      "Spend a saved usage reset by typing /usage reset in a chat; the app cannot do it from here yet.",
    );
  }

  /**
   * Opens omp's agent.db: read-only for reads, read-write only for logout and pin. omp owns the
   * file, so the app never changes its mode or anything else about it beyond those two writes.
   */
  private openDatabase(mode: "read" | "write"): Database | null {
    if (!existsSync(this.dbPath)) return null;
    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, mode === "read" ? { readonly: true } : undefined);
      db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return db;
    } catch (error) {
      db?.close();
      throw toFailure(error, "open provider credential store");
    }
  }

  private requireDatabase(mode: "read" | "write"): Database {
    const db = this.openDatabase(mode);
    if (!db) throw failure("not_found", "Provider account was not found.");
    return db;
  }
}

export function createProviderAccountStore(
  options: ProviderAccountStoreOptions = {},
): ProviderAccountStoreService {
  return new ProviderAccountStoreService(options);
}
