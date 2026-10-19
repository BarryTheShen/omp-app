import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MARKER_DIR = ".data/playground-build-markers";
const LOCK_STALE_MS = 10 * 60 * 1000;
const WAIT_MS = 20;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export interface PlaygroundBuildOptions {
  readonly root?: string;
  readonly key?: string;
  readonly runId?: string;
}

function buildKey(build: () => void): string {
  const caller = new Error().stack?.split("\n").find((line) => line.includes(".spec.ts")) ?? "";
  return createHash("sha256").update(`${caller}\n${build.toString()}`).digest("hex").slice(0, 16);
}

function currentRunId(): string {
  return process.env.PLAYWRIGHT_RUN_ID ?? `parent-${process.ppid}`;
}

function readMarker(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function acquireLock(path: string): number {
  for (;;) {
    try {
      return openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, WAIT_MS);
    }
  }
}

/** Builds one playground once per Playwright run, serializing workers that share its output. */
export function ensurePlaygroundBuilt(
  build: () => void,
  options: PlaygroundBuildOptions = {},
): void {
  const root = options.root ?? process.cwd();
  const markerRoot = join(root, MARKER_DIR);
  const key = options.key ?? buildKey(build);
  const marker = join(markerRoot, `${key}.marker`);
  const lock = join(markerRoot, `${key}.lock`);
  const runId = options.runId ?? currentRunId();

  mkdirSync(markerRoot, { recursive: true });
  if (readMarker(marker) === runId) return;

  const descriptor = acquireLock(lock);
  try {
    if (readMarker(marker) !== runId) {
      build();
      writeFileSync(marker, runId);
    }
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
  }
}
