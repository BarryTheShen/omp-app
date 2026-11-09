/**
 * Builds the extension into `dist/`: `extension.js` (VS Code's extension host runs it: Node, CommonJS, `vscode` left
 * to VS Code) and `webview.js` (the panel's page). With a version (`bun scripts/build.ts 0.3.1530`), `package.json`
 * takes it, as the release packs the extension with it.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const version = process.argv[2];

await rm(dist, { recursive: true, force: true });

const builds = [
  Bun.build({
    entrypoints: [join(root, "src/extension.ts")],
    outdir: dist,
    target: "node",
    format: "cjs",
    external: ["vscode"],
    minify: true,
  }),
  Bun.build({
    entrypoints: [join(root, "src/webview.ts")],
    outdir: dist,
    target: "browser",
    format: "iife",
    minify: true,
  }),
];
for (const result of await Promise.all(builds)) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

if (version !== undefined) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`"${version}" is not a version like 0.3.1530.`);
  const manifest = join(root, "package.json");
  const text = await readFile(manifest, "utf8");
  await writeFile(manifest, text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
}
console.log(`Built ${dist}${version === undefined ? "" : ` (version ${version})`}`);
