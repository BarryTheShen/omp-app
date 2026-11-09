/**
 * Runs `test/suite.ts` inside real VS Code (`bun run test:vscode`): it downloads VS Code once into
 * `VSCODE_TEST_CACHE` (default `.vscode-test/` here), builds the extension and the suite, and starts VS Code on a
 * throwaway folder with its own settings, no other extension, and no display (Chromium's headless backend).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const root = join(import.meta.dir, "..");

const built = Bun.spawnSync(["bun", "scripts/build.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (built.exitCode !== 0) process.exit(1);
const suite = await Bun.build({
  entrypoints: [join(root, "test/suite.ts")],
  outdir: join(root, "dist-test"),
  target: "node",
  format: "cjs",
  external: ["vscode"],
});
if (!suite.success) {
  for (const log of suite.logs) console.error(log);
  process.exit(1);
}

const scratch = await mkdtemp(join(tmpdir(), "omp-app-vscode-test-"));
try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    cachePath: process.env.VSCODE_TEST_CACHE ?? join(root, ".vscode-test"),
  });
  const workspace = join(scratch, "project");
  await Bun.write(join(workspace, ".keep"), "");
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "dist-test/suite.js"),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--ozone-platform=headless",
      "--disable-gpu",
      "--no-sandbox",
      `--user-data-dir=${join(scratch, "user")}`,
      `--extensions-dir=${join(scratch, "extensions")}`,
    ],
  });
  console.log("VS Code tests passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
  await rm(join(root, "dist-test"), { recursive: true, force: true });
}
