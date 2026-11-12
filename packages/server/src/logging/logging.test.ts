import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildDebugReport,
  createLogger,
  createNullLogger,
  debugReportFileName,
  LOG_FILE_NAME,
  readLogTail,
  scrubText,
  startStatsSampler,
  stateDirectory,
} from "./index";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  await mkdir(DATA, { recursive: true });
  const root = await mkdtemp(join(DATA, "logging-"));
  roots.push(root);
  return root;
}

/** A made-up provider key, joined at run time so no line of this file looks like a real one. */
function fakeKey(): string {
  return ["sk", "ant", "api03", "A".repeat(10) + "b".repeat(10) + "1".repeat(10)].join("-");
}

describe("scrubText", () => {
  test("replaces keys, tokens and long random secrets", () => {
    const key = fakeKey();
    const samples = [
      key,
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"B".repeat(30)}`,
      `Authorization: Bearer ${"x".repeat(30)}`,
      "open http://127.0.0.1:4317/#token=Zm9vYmFyYmF6cXV4",
      'config {"api_key": "hunter2hunter2"}',
      "password=correcthorse",
      `${"aB3".repeat(12)}`,
    ];
    for (const sample of samples) {
      const scrubbed = scrubText(`before ${sample} after`);
      expect(scrubbed).toContain("[redacted]");
      expect(scrubbed).not.toContain("hunter2hunter2");
      expect(scrubbed).not.toContain("correcthorse");
      expect(scrubbed).not.toContain("Zm9vYmFyYmF6cXV4");
      expect(scrubbed).not.toContain(key);
    }
  });

  test("removes a device key in its cookie and its WebSocket protocol, a key with no digit too", () => {
    const key = "aBcDeFgHiJ".repeat(4).concat("kLm");
    for (const sample of [
      `cookie omp-app-device=${key}`,
      `offered omp-app, omp-app.device.${key}`,
    ]) {
      const scrubbed = scrubText(sample);
      expect(scrubbed).toContain("[redacted]");
      expect(scrubbed).not.toContain(key);
    }
  });

  test("keeps what a debug log needs: paths, ids, versions, git hashes and digests", () => {
    const kept = [
      "/home/user/workspace/projects/omp-app/.worktrees/fix-release-sessions/packages/server",
      "01a114f3-4561-704b-af2c-12f39db8f147",
      "omp 18.7.0 pid=1234 code=0",
      "3bf5582874c60b97243cac35851bc7771b224f39",
      "a".repeat(64),
      "http://127.0.0.1:4317/ws",
      "https://github.com/owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
    ];
    for (const text of kept) expect(scrubText(text)).toBe(text);
  });

  test("replaces an exact secret wherever it appears", () => {
    expect(scrubText("token is abc123xyz and again abc123xyz", ["abc123xyz"])).toBe(
      "token is [redacted] and again [redacted]",
    );
    // A secret too short to be one is left alone: replacing "a" would wreck the line.
    expect(scrubText("a b c", ["a"])).toBe("a b c");
  });

  test("removes a bearer token after an Authorization header, and keeps the header's name", () => {
    expect(scrubText("Authorization: Bearer abcdefghijklmnop1234")).toBe(
      "Authorization: [redacted]",
    );
  });

  test("removes the credentials of a Basic authorization header, Proxy-Authorization included, and keeps the header's name", () => {
    // The token is base64 of user:password. It is built here, so no literal credential sits in this source file.
    const token = Buffer.from(["alice", "hunter2pass"].join(":")).toString("base64");
    expect(scrubText(`Authorization: Basic ${token}`)).toBe("Authorization: Basic [redacted]");
    expect(scrubText(`Proxy-Authorization: Basic ${token}`)).toBe(
      "Proxy-Authorization: Basic [redacted]",
    );
    // The user name is inside the token, so the whole token goes and the name does not stay behind.
    const quoted = scrubText(`{"authorization": "Basic ${token}"}`);
    expect(quoted).toBe('{"authorization": "Basic [redacted]"}');
    expect(quoted).not.toContain("alice");
  });

  test("removes the password from a URL with credentials, and keeps the user and host", () => {
    expect(
      scrubText(
        "unable to access 'https://alice:hunter2pass@github.com/owner/repo.git/': The requested URL returned error: 403",
      ),
    ).toBe(
      "unable to access 'https://alice:[redacted]@github.com/owner/repo.git/': The requested URL returned error: 403",
    );
  });
});

describe("createLogger", () => {
  test("writes one readable line per event, never lets a secret through, and keeps the file private", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir, now: () => new Date("2026-10-07T06:00:00.000Z") });
    logger.addSecret("launch-token-1234567");
    logger.info("omp.process", { status: "running", pid: 4242, note: "has spaces" });
    logger.warn("port.error", {
      message: `denied launch-token-1234567 ${fakeKey()}`,
      ignored: undefined,
    });
    const text = readLogTail(dir, 10);
    expect(text.split("\n")).toEqual([
      '2026-10-07T06:00:00.000Z INFO  omp.process status=running pid=4242 note="has spaces"',
      '2026-10-07T06:00:00.000Z WARN  port.error message="denied [redacted] [redacted]"',
    ]);
    expect((await stat(logger.path)).mode & 0o777).toBe(0o600);
    expect(logger.path).toBe(join(dir, LOG_FILE_NAME));
  });

  test("a failure that quotes a Basic authorization header reaches the log without its credentials", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir, now: () => new Date("2026-10-07T06:00:00.000Z") });
    const token = Buffer.from(["alice", "hunter2pass"].join(":")).toString("base64");
    logger.error("request.failed", { message: `Authorization: Basic ${token} was refused` });
    const text = readLogTail(dir, 5);
    expect(text).toContain("Authorization: Basic [redacted] was refused");
    expect(text).not.toContain(token);
    expect(text).not.toContain("alice");
  });

  test("cuts long values (300 characters, a stack 2,000) and keeps a multi-line message on one line", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir });
    logger.error("crash", {
      message: "m".repeat(1000),
      stack: `Error: boom\n  at a (x.ts:1:1)\n${"y".repeat(5000)}`,
    });
    const [line, ...rest] = readLogTail(dir, 5).split("\n");
    expect(rest).toEqual([]);
    expect(line).toContain("Error: boom\\n  at a (x.ts:1:1)");
    expect(line).toContain("(+700 chars)");
    expect(line).toMatch(/\(\+30\d\d chars\)/);
    expect((line ?? "").length).toBeLessThan(2_500);
  });

  test("rotates so the two files together stay under the limit, and the tail spans both", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir, maxBytes: 4_000 });
    for (let index = 0; index < 200; index += 1) {
      logger.info("tick", { n: index, padding: "p".repeat(30) });
    }
    const files = (await readdir(dir)).sort();
    expect(files).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.1`]);
    const total =
      (await stat(join(dir, files[0] ?? ""))).size + (await stat(join(dir, files[1] ?? ""))).size;
    expect(total).toBeLessThanOrEqual(4_000 + 200);
    const tail = logger.tail(30).split("\n");
    expect(tail).toHaveLength(30);
    expect(tail.at(-1)).toContain("n=199");
    // The newest lines come in order, even across the rotation.
    const numbers = tail.map((line) => Number(line.match(/n=(\d+)/)?.[1]));
    expect(numbers).toEqual(numbers.toSorted((left, right) => left - right));
  });

  test("a log already past its half limit is rotated when the app starts", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, LOG_FILE_NAME), `${"old line\n".repeat(500)}`);
    createLogger({ dir, maxBytes: 2_000 }).info("fresh");
    expect((await readdir(dir)).sort()).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.1`]);
    expect(readLogTail(dir, 3).split("\n").at(-1)).toContain("fresh");
  });

  test("the null logger is silent", () => {
    const logger = createNullLogger();
    logger.info("anything", { a: 1 });
    expect(logger.tail(5)).toBe("");
  });
});

describe("stats sampler", () => {
  test("writes memory, the omp processes and their memory, and the worst event-loop delay", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir });
    const sampler = startStatsSampler({
      logger,
      intervalMs: 60_000,
      processes: () => [
        { pid: 11, status: "running" },
        { pid: 22, status: "running" },
        { pid: undefined, status: "starting" },
      ],
      readRssKb: (pid) => (pid === 11 ? 300 * 1024 : pid === 22 ? 80 * 1024 : undefined),
    });
    // Block the loop across the first scheduled probe (at 250 ms) so the tick is late.
    const until = Date.now() + 450;
    while (Date.now() < until) {
      /* busy */
    }
    await Bun.sleep(60);
    sampler.sample();
    sampler.stop();
    const line = readLogTail(dir, 1);
    expect(line).toContain(" INFO  stats ");
    expect(line).toContain("omp_count=3");
    expect(line).toContain("omp_rss_mb=380");
    expect(line).toContain("omp_max_mb=300");
    expect(line).toContain("omp_pids=11,22");
    expect(Number(line.match(/rss_mb=(\d+)/)?.[1])).toBeGreaterThan(10);
    expect(Number(line.match(/loop_lag_ms=(\d+)/)?.[1])).toBeGreaterThanOrEqual(80);
  });
});

describe("debug report", () => {
  test("has the header, the last log lines and the processes, and scrubs once more", async () => {
    const dir = await tempDir();
    const logger = createLogger({ dir, now: () => new Date("2026-10-07T06:00:00.000Z") });
    for (let index = 0; index < 50; index += 1) logger.info("tick", { n: index });
    // A line written by an older build (or by hand) that the scrubber would have caught today.
    await writeFile(
      join(dir, LOG_FILE_NAME),
      `${readLogTail(dir, 50)}\nlegacy token=thisisnotallowed1\n`,
    );
    const report = buildDebugReport({
      directory: dir,
      version: "0.1.999",
      now: new Date("2026-10-07T07:08:09.000Z"),
      omp: { path: "/usr/bin/omp", version: "18.7.0" },
      processes: "PID RSS ELAPSED COMMAND\n123 380000 02:00 chat-host __omp_app_chat",
      lines: 10,
    });
    expect(report).toContain("omp app debug report");
    expect(report).toContain("app version: 0.1.999");
    expect(report).toContain("omp: 18.7.0 at /usr/bin/omp");
    expect(report).toContain("--- last 10 log lines ---");
    expect(report).toContain("n=49");
    expect(report).not.toContain("n=39 ");
    expect(report).toContain("123 380000 02:00 chat-host __omp_app_chat");
    expect(report).not.toContain("thisisnotallowed1");
    expect(debugReportFileName(new Date("2026-10-07T07:08:09.000Z"))).toBe(
      "omp-app-debug-20261007-070809.log",
    );
  });
});

describe("stateDirectory", () => {
  test("uses an absolute XDG_STATE_HOME, otherwise ~/.local/state", () => {
    expect(stateDirectory({ XDG_STATE_HOME: "/var/state" }, "/home/me")).toBe("/var/state/omp-app");
    expect(stateDirectory({ XDG_STATE_HOME: "relative" }, "/home/me")).toBe(
      "/home/me/.local/state/omp-app",
    );
    expect(stateDirectory({}, "/home/me")).toBe("/home/me/.local/state/omp-app");
  });
});
