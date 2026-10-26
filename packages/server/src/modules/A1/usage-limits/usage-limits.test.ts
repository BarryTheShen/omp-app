import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageLimitStoreService } from "./usage-limits";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A stand-in for omp: a shell script that runs `body` in place of `omp usage`. */
async function fakeOmp(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-usage-limits-"));
  directories.push(directory);
  const binary = join(directory, "omp");
  await writeFile(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return binary;
}

const PATH = process.env.PATH ?? "/usr/bin:/bin";

// The shape omp 18.12.6 prints for `omp usage --json` (pi-coding-agent src/cli/usage-cli.ts:1105-1146, payload at
// :1648-1655): reports with their limits, and account identities that must never reach the app.
const usageJson = JSON.stringify({
  generatedAt: 1_000,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: 1_000,
      metadata: { email: "person@example.com", accountId: "acct-secret-1" },
      limits: [
        {
          id: "anthropic:5h",
          label: "5 Hour",
          window: { id: "5h", label: "5 Hour", resetsAt: Date.parse("2026-10-10T08:30:00.000Z") },
          amount: { usedFraction: 0.41 },
        },
        {
          id: "anthropic:7d",
          label: "7 Day",
          window: { id: "7d", label: "7 Day" },
          amount: { usedFraction: 0.2 },
        },
      ],
    },
    {
      provider: "anthropic",
      fetchedAt: 1_000,
      metadata: { email: "other@example.com", accountId: "acct-secret-2" },
      limits: [
        {
          id: "anthropic:5h",
          label: "5 Hour",
          window: { id: "5h", label: "5 Hour", resetsAt: Date.parse("2026-10-10T09:00:00.000Z") },
          amount: { used: 60, limit: 100 },
        },
      ],
    },
    {
      provider: "openai-codex",
      fetchedAt: 1_000,
      limits: [
        {
          id: "openai-codex:7d",
          label: "7 Day",
          window: { id: "7d", label: "7 Day", resetsAt: Date.parse("2026-10-14T00:00:00.000Z") },
          amount: { usedFraction: 1.25 },
        },
      ],
    },
  ],
  accountsWithoutUsage: [{ provider: "anthropic", email: "third@example.com" }],
});

describe("the provider usage limits omp reports", () => {
  test("summarises each provider's windows: the fullest account's share and reset, and how many accounts report it, with no identity", async () => {
    const service = new UsageLimitStoreService({
      command: [await fakeOmp(`cat <<'EOF'\n${usageJson}\nEOF`)],
      env: { PATH },
      now: () => 1_000,
    });

    const result = await service.read();

    expect(result).toEqual({
      state: "ready",
      fetchedAt: "1970-01-01T00:00:01.000Z",
      providers: [
        {
          providerId: "anthropic",
          windows: [
            { label: "5 Hour", usedPercent: 60, resetsAt: "2026-10-10T09:00:00.000Z", accounts: 2 },
            { label: "7 Day", usedPercent: 20, resetsAt: null, accounts: 1 },
          ],
        },
        {
          providerId: "openai-codex",
          windows: [
            { label: "7 Day", usedPercent: 125, resetsAt: "2026-10-14T00:00:00.000Z", accounts: 1 },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/example\.com|acct-secret/);
  });

  test("says why when omp does not answer within the deadline, and stops it", async () => {
    const service = new UsageLimitStoreService({
      command: [await fakeOmp("sleep 5")],
      env: { PATH },
      timeoutMs: 2_000,
    });

    await expect(service.read()).resolves.toEqual({
      state: "unavailable",
      reason: "omp did not report provider limits within 2 seconds.",
    });
  });

  test("says why when omp stops with an error, and never shows what it wrote to stderr", async () => {
    const service = new UsageLimitStoreService({
      command: [await fakeOmp("echo 'token sk-secret-value' >&2\nexit 3")],
      env: { PATH },
    });

    const result = await service.read();

    expect(result).toEqual({ state: "unavailable", reason: "omp usage stopped with exit code 3." });
    expect(JSON.stringify(result)).not.toContain("sk-secret-value");
  });

  test("says why when omp's output is not JSON", async () => {
    const service = new UsageLimitStoreService({
      command: [await fakeOmp("echo 'not json at all'")],
      env: { PATH },
    });

    await expect(service.read()).resolves.toEqual({
      state: "unavailable",
      reason: "omp's usage output could not be read.",
    });
  });

  test("says why when the output has no reports list in a form the app reads", async () => {
    const service = new UsageLimitStoreService({
      command: [await fakeOmp("echo '{\"generatedAt\": 1}'")],
      env: { PATH },
    });

    await expect(service.read()).resolves.toEqual({
      state: "unavailable",
      reason: "omp's usage output was not in a form this app reads.",
    });
  });

  test("reuses a read for a minute, and concurrent reads share one omp run", async () => {
    // The script counts its own runs in the directory it lives in ($0), so the counter needs no setup.
    const binary = await fakeOmp(
      `echo run >> "$(dirname "$0")/runs.txt"\ncat <<'EOF'\n${usageJson}\nEOF`,
    );
    const counter = join(dirname(binary), "runs.txt");
    const runs = async () => (await readFile(counter, "utf8")).trim().split("\n").length;
    let now = 1_000;
    const service = new UsageLimitStoreService({
      command: [binary],
      env: { PATH },
      now: () => now,
      cacheMs: 60_000,
    });

    await Promise.all([service.read(), service.read(), service.read()]);
    expect(await runs()).toBe(1);

    now = 30_000;
    await service.read();
    expect(await runs()).toBe(1);

    now = 61_001;
    await service.read();
    expect(await runs()).toBe(2);
  });

  test("says that omp could not be started when there is no omp to run", async () => {
    const service = new UsageLimitStoreService({
      command: ["/nonexistent/omp-app-usage-limits-test/omp"],
      env: { PATH },
    });

    await expect(service.read()).resolves.toMatchObject({ state: "unavailable" });
  });
});
