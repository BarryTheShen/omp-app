import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const helper = pathToFileURL(join(process.cwd(), "e2e/playground-build.ts")).href;

function runWorker(root: string, count: string): Promise<void> {
  const source = `
    import { appendFileSync } from "node:fs";
    import { ensurePlaygroundBuilt } from ${JSON.stringify(helper)};
    ensurePlaygroundBuilt(() => {
      appendFileSync(${JSON.stringify(count)}, "built\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }, { root: ${JSON.stringify(root)}, key: "two-worker", runId: "test-run" });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", source], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with ${code}: ${stderr}`));
    });
  });
}

describe("ensurePlaygroundBuilt", () => {
  test("only one of two workers builds a page for the run", async () => {
    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    const root = mkdtempSync(join(process.cwd(), ".data", "playground-build-test-"));
    const count = join(root, "build-count.txt");
    try {
      await Promise.all([runWorker(root, count), runWorker(root, count)]);
      expect(readFileSync(count, "utf8")).toBe("built\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
