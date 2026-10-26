import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CHAT_HOST_BUN_VERSION } from "../../../packages/server/scripts/chat-host-bun";

/**
 * Live tests run omp the way the packages ship it: the chat host program compiled by
 * `packages/server/scripts/build-chat-host.ts` (#2586, SDK plan H5.1), which runs every chat and answers omp's own
 * commands. omp's command line run from source on the Bun that runs the tests is not that program: on the test machine it failed
 * `fix-1351` and `fix-1910` 7 times in 9 (a slow first reply, a settings change a running chat did not see), which pass
 * on the compiled one.
 *
 * Once per run, before the workers start, this puts the compiled chat host in `OMP_APP_CHAT_HOST_BIN`, which the app's
 * server and the harness read (workers inherit the variable). A build is kept in `OMP_APP_CHAT_HOST_DIR` (on the test machine the
 * shared `/cache/bun/chat-host`), else this checkout's `.data/chat-host`, under a name from everything the program is
 * built from (`compiledChatHost`), so it is built once for each version of them; a lock keeps parallel runs from building
 * it twice.
 *
 * The build needs the Bun omp's release is built with (`chat-host-bun.ts`). `OMP_APP_CHAT_HOST_BUN` names it; else it is
 * downloaded once from Bun's release into the same folder, checked against the release's `SHASUMS256.txt`, as
 * `release.yml` does.
 */
const APP_ROOT = resolve(process.cwd(), "../..");
const BUILD_SCRIPT = join(APP_ROOT, "packages/server/scripts/build-chat-host.ts");
const BUN_VERSION_FILE = join(APP_ROOT, "packages/server/scripts/chat-host-bun.ts");
const LOCK_STALE_MS = 15 * 60_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Bun's release asset, as text or bytes: the download is checked by its checksum, never trusted by its address. */
async function download(file: string): Promise<Uint8Array> {
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${CHAT_HOST_BUN_VERSION}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The Bun that compiles the chat host: `OMP_APP_CHAT_HOST_BUN`, else Bun's release, downloaded once into `dir`. */
async function chatHostBun(dir: string): Promise<string> {
  const named = process.env.OMP_APP_CHAT_HOST_BUN;
  if (named) return named;
  const bunDir = join(dir, `bun-${CHAT_HOST_BUN_VERSION}`);
  const bun = join(bunDir, "bun-linux-x64", "bun");
  if (existsSync(bun)) return bun;
  const [zip, sums] = await Promise.all([
    download("bun-linux-x64.zip"),
    download("SHASUMS256.txt"),
  ]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .find((line) => line.trim().endsWith(" bun-linux-x64.zip"))
    ?.split(/\s+/)[0];
  const actual = createHash("sha256").update(zip).digest("hex");
  if (expected === undefined || actual !== expected) {
    throw new Error(`Bun ${CHAT_HOST_BUN_VERSION}'s download does not match its SHASUMS256.txt`);
  }
  const partial = `${bunDir}.${process.pid}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, "bun-linux-x64.zip"), zip);
  const unzipped = spawnSync("unzip", ["-q", "bun-linux-x64.zip"], {
    cwd: partial,
    encoding: "utf8",
  });
  if (unzipped.status !== 0) {
    rmSync(partial, { recursive: true, force: true });
    throw new Error(
      `unzip failed for Bun ${CHAT_HOST_BUN_VERSION}: ${unzipped.stderr || unzipped.error}`,
    );
  }
  rmSync(join(partial, "bun-linux-x64.zip"));
  // The folder is renamed into place whole, so one that is there without its binary was emptied by hand: replace it.
  rmSync(bunDir, { recursive: true, force: true });
  renameSync(partial, bunDir);
  return bun;
}

/**
 * The app's own code inside the program: its entry (`src/chat-host`) and the contracts it imports, with the manifests
 * whose `exports` resolve them. A change there needs a new build as much as a new lockfile does.
 */
const PROGRAM_SOURCES = ["packages/server/src/chat-host", "packages/contracts/src"];
const PROGRAM_MANIFESTS = ["packages/server/package.json", "packages/contracts/package.json"];

function hashProgramSources(hash: Hash): Hash {
  for (const dir of PROGRAM_SOURCES) {
    const root = join(APP_ROOT, dir);
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|json)$/.test(file) && !file.endsWith(".test.ts"))
      .sort();
    for (const file of files)
      hash.update(`${dir}/${file}\0`).update(readFileSync(join(root, file)));
  }
  for (const manifest of PROGRAM_MANIFESTS) hash.update(readFileSync(join(APP_ROOT, manifest)));
  return hash;
}

/** The compiled chat host for this checkout's lockfile, build script and program sources, built once and then reused. */
async function compiledChatHost(): Promise<string> {
  const key = hashProgramSources(
    createHash("sha256")
      .update(readFileSync(join(APP_ROOT, "bun.lock")))
      .update(readFileSync(BUILD_SCRIPT))
      .update(readFileSync(BUN_VERSION_FILE)),
  )
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
      const bun = await chatHostBun(dir);
      const partial = `${target}.${process.pid}.partial`;
      const built = spawnSync(bun, [BUILD_SCRIPT, partial], {
        cwd: APP_ROOT,
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

export default async function globalSetup(): Promise<void> {
  if (process.env.OMP_APP_REAL_OMP !== "1" || process.env.OMP_APP_CHAT_HOST_BIN) return;
  process.env.OMP_APP_CHAT_HOST_BIN = await compiledChatHost();
}
