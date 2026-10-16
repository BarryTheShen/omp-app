import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppFailure, ThreadId } from "@omp-app/contracts";
import { ProviderAccountStoreService } from "./provider-account-store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-provider-accounts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function databasePath(home: string): string {
  return join(home, ".omp", "agent", "agent.db");
}

function openCredentialDatabase(home: string): Database {
  const db = new Database(databasePath(home));
  db.run(`
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL,
      identity_key TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    -- Mirrors omp v18.8.9's auth/sqlite-credential-store.ts change tracking.
    CREATE TABLE IF NOT EXISTS auth_change_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO auth_change_revision (id, revision) VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS auth_change_revision_auth_credentials_insert
    AFTER INSERT ON auth_credentials
    BEGIN
      UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS auth_change_revision_auth_credentials_update
    AFTER UPDATE ON auth_credentials
    BEGIN
      UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS auth_change_revision_auth_credentials_delete
    AFTER DELETE ON auth_credentials
    BEGIN
      UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
    END;
  `);
  return db;
}

function accountRow(
  provider: string,
  credentialType: "oauth" | "api_key",
  data: string,
): { provider: string; credentialType: string; data: string } {
  return { provider, credentialType, data };
}

function insertAccount(
  db: Database,
  row: { provider: string; credentialType: string; data: string },
): void {
  db.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run(
    row.provider,
    row.credentialType,
    row.data,
  );
}

async function expectAppFailure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
    throw new Error("Expected an AppFailure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    return error as AppFailure;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProviderAccountStoreService", () => {
  test("resolves the same agent directory as omp", async () => {
    const home = await temporaryDirectory();
    const profileStore = new ProviderAccountStoreService({
      homeDir: home,
      env: { OMP_PROFILE: "work" },
    });
    expect(profileStore.agentDir).toBe(join(home, ".omp", "profiles", "work", "agent"));
    expect(profileStore.dbPath).toBe(join(home, ".omp", "profiles", "work", "agent", "agent.db"));

    const overrideStore = new ProviderAccountStoreService({
      homeDir: home,
      env: { PI_CODING_AGENT_DIR: "~/custom-agent", OMP_PROFILE: "ignored" },
    });
    expect(overrideStore.agentDir).toBe(join(home, "custom-agent"));
  });

  test("returns empty discovery when omp has no agent database", async () => {
    const home = await temporaryDirectory();
    const store = new ProviderAccountStoreService({ homeDir: home, env: {} });

    expect(await store.listProviders()).toEqual({ providers: [] });
    expect(await store.listAccounts({ providerId: "anthropic" })).toEqual({
      providerId: "anthropic",
      accounts: [],
    });
  });

  test("lists provider accounts with opaque ids and redacted labels", async () => {
    const home = await temporaryDirectory();
    await mkdir(join(home, ".omp", "agent"), { recursive: true });
    const db = openCredentialDatabase(home);
    const accessToken = ["Bearer", "t".repeat(32)].join(" ");
    const refreshToken = ["refresh", "r".repeat(32)].join("-");
    const apiKey = ["sk", "ant", "k".repeat(30)].join("-");
    const email = ["user", "example.test"].join("@");
    insertAccount(
      db,
      accountRow(
        "openai-codex",
        "oauth",
        JSON.stringify({
          access: accessToken,
          refresh: refreshToken,
          email,
          expiresAt: Date.now() + 60_000,
        }),
      ),
    );
    insertAccount(db, accountRow("openai-codex", "api_key", JSON.stringify({ key: apiKey })));
    db.close();

    const store = new ProviderAccountStoreService({ homeDir: home, env: {} });
    const providers = await store.listProviders();
    const accounts = await store.listAccounts({ providerId: "openai-codex" });
    const serialized = JSON.stringify({ providers, accounts });

    expect(providers.providers).toEqual([
      expect.objectContaining({
        id: "openai-codex",
        name: "OpenAI Codex",
        available: true,
        authenticated: true,
        credentialKinds: ["oauth", "api_key"],
        source: "agent-db",
      }),
    ]);
    expect(accounts.accounts).toHaveLength(2);
    expect(accounts.accounts[0]).toMatchObject({
      providerId: "openai-codex",
      label: "u***@example.test",
      active: false,
      source: "oauth",
    });
    expect(accounts.accounts[0]?.id).toMatch(/^acct-[a-f0-9]{24}$/);
    expect(accounts.accounts[0]?.expiresAt).toBeDefined();
    expect(accounts.accounts[1]).toMatchObject({
      label: "API key",
      source: "agent-db",
      active: false,
    });
    for (const secret of [accessToken, refreshToken, apiKey, email]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('"id":1');
    expect(serialized).not.toContain('"id":2');
  });

  test("marks the session-pinned OAuth account active without returning cache bytes", async () => {
    const home = await temporaryDirectory();
    await mkdir(join(home, ".omp", "agent"), { recursive: true });
    const db = openCredentialDatabase(home);
    const accessToken = ["access", "a".repeat(32)].join("-");
    insertAccount(
      db,
      accountRow(
        "anthropic",
        "oauth",
        JSON.stringify({ access: accessToken, accountId: "account-opaque" }),
      ),
    );
    db.query("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)").run(
      "session:sticky:anthropic:session-1",
      JSON.stringify({
        type: "oauth",
        index: 0,
        credentialId: 1,
        lastUsedAtMs: Date.now(),
        explicit: true,
      }),
      Math.floor(Date.now() / 1000) + 60,
    );
    db.close();

    const store = new ProviderAccountStoreService({ homeDir: home, env: {} });
    const result = await store.listAccounts({
      providerId: "anthropic",
      sessionId: ThreadId.parse("session-1"),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.active).toBe(true);
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  test("pins only stored OAuth accounts using omp's documented cache affinity row", async () => {
    const home = await temporaryDirectory();
    await mkdir(join(home, ".omp", "agent"), { recursive: true });
    const db = openCredentialDatabase(home);
    insertAccount(
      db,
      accountRow("anthropic", "oauth", JSON.stringify({ access: ["a", "a".repeat(32)].join("-") })),
    );
    insertAccount(
      db,
      accountRow("anthropic", "api_key", JSON.stringify({ key: ["k", "b".repeat(32)].join("-") })),
    );
    db.close();

    const store = new ProviderAccountStoreService({ homeDir: home, env: {} });
    const listed = await store.listAccounts({ providerId: "anthropic" });
    const oauthId = listed.accounts[0]?.id;
    if (!oauthId) throw new Error("Expected an OAuth account id.");
    const sessionId = ThreadId.parse("session-pin");
    const result = await store.pin({ sessionId, providerId: "anthropic", accountId: oauthId });
    expect(result).toEqual({
      sessionId,
      providerId: "anthropic",
      accountId: oauthId,
      pinned: true,
    });

    const check = new Database(databasePath(home));
    const row = check
      .query("SELECT value, expires_at FROM cache WHERE key = ?")
      .get("session:sticky:anthropic:session-pin") as { value: string; expires_at: number };
    check.close();
    expect(JSON.parse(row.value)).toMatchObject({
      type: "oauth",
      index: 0,
      credentialId: 1,
      explicit: true,
    });
    expect(row.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(JSON.stringify(result)).not.toContain("access");
  });

  test("logs out one account by opaque id and leaves unrelated accounts active", async () => {
    const home = await temporaryDirectory();
    await mkdir(join(home, ".omp", "agent"), { recursive: true });
    const db = openCredentialDatabase(home);
    insertAccount(db, accountRow("openai-codex", "oauth", JSON.stringify({ accountId: "one" })));
    insertAccount(db, accountRow("openai-codex", "oauth", JSON.stringify({ accountId: "two" })));
    const revisionBeforeLogout = (
      db.query("SELECT revision FROM auth_change_revision WHERE id = 1").get() as {
        revision: number;
      }
    ).revision;
    db.close();

    const store = new ProviderAccountStoreService({ homeDir: home, env: {} });
    const listed = await store.listAccounts({ providerId: "openai-codex" });
    const first = listed.accounts[0];
    const second = listed.accounts[1];
    if (!first || !second) throw new Error("Expected two provider accounts.");
    expect(await store.logout({ providerId: "openai-codex", accountId: first.id })).toEqual({
      providerId: "openai-codex",
      accountId: first.id,
      removed: true,
    });
    expect((await store.listAccounts({ providerId: "openai-codex" })).accounts).toEqual([second]);

    const check = new Database(databasePath(home));
    const rows = check
      .query("SELECT id, disabled_cause FROM auth_credentials ORDER BY id")
      .all() as Array<{
      id: number;
      disabled_cause: string | null;
    }>;
    const revisionAfterLogout = (
      check.query("SELECT revision FROM auth_change_revision WHERE id = 1").get() as {
        revision: number;
      }
    ).revision;
    check.close();
    expect(revisionAfterLogout).toBe(revisionBeforeLogout + 1);
    expect(rows).toEqual([
      { id: 1, disabled_cause: "deleted by user" },
      { id: 2, disabled_cause: null },
    ]);
  });

  test("reports not-found, unavailable reset, and unavailable schema failures without raw data", async () => {
    const home = await temporaryDirectory();
    await mkdir(join(home, ".omp", "agent"), { recursive: true });
    const db = openCredentialDatabase(home);
    insertAccount(
      db,
      accountRow("anthropic", "oauth", JSON.stringify({ access: ["x", "x".repeat(32)].join("-") })),
    );
    db.close();

    const store = new ProviderAccountStoreService({ homeDir: home, env: {} });
    const account = (await store.listAccounts({ providerId: "anthropic" })).accounts[0];
    if (!account) throw new Error("Expected an account.");
    const missing = await expectAppFailure(
      store.logout({ providerId: "anthropic", accountId: "acct-000000000000000000000000" }),
    );
    expect(missing.appError.code).toBe("not_found");

    const reset = await expectAppFailure(
      store.resetUsage({ providerId: "anthropic", accountId: account.id }),
    );
    expect(reset.appError).toMatchObject({
      code: "unavailable",
      capability: "host.provider-accounts",
    });
    expect(reset.appError.message).not.toContain("x".repeat(32));

    const emptyDbPath = join(home, ".omp", "agent", "empty.db");
    const empty = new Database(emptyDbPath);
    empty.close();
    const emptyStore = new ProviderAccountStoreService({ dbPath: emptyDbPath });
    const schemaError = await expectAppFailure(emptyStore.listProviders());
    expect(schemaError.appError.code).toBe("unavailable");
  });
});
