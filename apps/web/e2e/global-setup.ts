import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Live tests run every chat on the chat host the packages ship: omp's command line compiled by
 * `packages/server/scripts/build-chat-host.ts` (#2586). omp's command line run from source on the Bun that runs the tests
 * is not that program: on the test machine it failed `fix-1351` and `fix-1910` 7 times in 9 (a slow first reply, a settings change a
 * running chat did not see), which pass on the compiled one.
 *
 * Once per run, before the workers start, this puts the compiled chat host in `OMP_APP_CHAT_HOST_BIN`, which the app's
 * server reads (workers inherit the variable). A build is kept in `OMP_APP_CHAT_HOST_DIR` (on the test machine the shared
 * `/cache/bun/chat-host`), else this checkout's `.data/chat-host`, under a name from the lockfile and the build script, so
 * it is built once for each of their versions; a lock keeps parallel runs from building it twice.
 *
 * The build needs the Bun omp's release is built with. `OMP_APP_CHAT_HOST_BUN` names it; else the omp release the app
 * pins serves as that Bun (a program Bun compiled runs as its Bun with `BUN_BE_BUN=1`).
 */
const APP_ROOT = resolve(process.cwd(), "../..");
const BUILD_SCRIPT = join(APP_ROOT, "packages/server/scripts/build-chat-host.ts");
const LOCK_STALE_MS = 15 * 60_000;

function pinnedOmp(): string {
  const pin: unknown = JSON.parse(
    readFileSync(join(APP_ROOT, "packages/server/src/omp-pin/pin.json"), "utf8"),
  );
  if (
    typeof pin !== "object" ||
    pin === null ||
    !("version" in pin) ||
    typeof pin.version !== "string"
  ) {
    throw new Error("packages/server/src/omp-pin/pin.json names no omp version");
  }
  return join(process.env.OMP_APP_OMP_DIR ?? join(APP_ROOT, ".data", "omp"), `omp-${pin.version}`);
}

/** The Bun command that runs the build script: `OMP_APP_CHAT_HOST_BUN`, else the pinned omp as its own Bun. */
function buildCommand(): { readonly command: string; readonly env: NodeJS.ProcessEnv } {
  const named = process.env.OMP_APP_CHAT_HOST_BUN;
  if (named) return { command: named, env: process.env };
  const omp = pinnedOmp();
  if (!existsSync(omp)) {
    throw new Error(
      `The chat host is built with omp's Bun: set OMP_APP_CHAT_HOST_BUN, or put the app's omp at ${omp} (bun packages/server/scripts/fetch-omp.ts).`,
    );
  }
  return { command: omp, env: { ...process.env, BUN_BE_BUN: "1" } };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The compiled chat host for this checkout's lockfile and build script, built once and then reused. */
function compiledChatHost(): string {
  const key = createHash("sha256")
    .update(readFileSync(join(APP_ROOT, "bun.lock")))
    .update(readFileSync(BUILD_SCRIPT))
    .digest("hex")
    .slice(0, 16);
  const dir = process.env.OMP_APP_CHAT_HOST_DIR ?? join(APP_ROOT, ".data", "chat-host");
  const target = join(dir, `chat-host-${key}`);
  const lock = `${target}.lock`;
  mkdirSync(dir, { recursive: true });
  for (;;) {
    if (existsSync(target)) return target;
    try {
      mkdirSync(lock);
    } catch {
      // Another run builds it; a lock older than any build is left over from a run that died.
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      sleep(2_000);
      continue;
    }
    try {
      if (existsSync(target)) return target;
      const partial = `${target}.${process.pid}.partial`;
      const { command, env } = buildCommand();
      const built = spawnSync(command, [BUILD_SCRIPT, partial], {
        cwd: APP_ROOT,
        env,
        encoding: "utf8",
        timeout: 10 * 60_000,
      });
      if (built.status !== 0 || !existsSync(partial)) {
        rmSync(partial, { force: true });
        throw new Error(
          `The chat host did not build (exit ${built.status}): ${`${built.stdout}${built.stderr}`.trim().slice(-2_000)}`,
        );
      }
      renameSync(partial, target);
      return target;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

export default function globalSetup(): void {
  if (process.env.OMP_APP_REAL_OMP !== "1" || process.env.OMP_APP_CHAT_HOST_BIN) return;
  process.env.OMP_APP_CHAT_HOST_BIN = compiledChatHost();
}
