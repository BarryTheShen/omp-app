/**
 * Builds the extension into `dist/`: one script per page (the panel, the options, the toolbar button's background), the
 * pages, the manifest and the app's icon. `dist/` is what Firefox loads (about:debugging → This Firefox → Load Temporary
 * Add-on → its manifest.json) and what Mozilla signs.
 *
 * `bun scripts/build.ts [version]`: a release passes its own version (`0.3.1527`), which goes into the manifest, since
 * Mozilla signs each version once. Without one the manifest keeps its own.
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const version = process.argv[2];
// Firefox's form: one to four numbers, no leading zeros.
if (version !== undefined && !/^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/.test(version)) {
  console.error(`"${version}" is not a version Firefox takes, such as 0.3.1527.`);
  process.exit(1);
}

const here = resolve(import.meta.dir, "..");
const out = join(here, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const built = await Bun.build({
  entrypoints: ["panel", "options", "background"].map((name) => join(here, "src", `${name}.ts`)),
  outdir: out,
  target: "browser",
  format: "esm",
  // The page functions are sent to the tab as their source: kept whole, never renamed or split.
  minify: false,
  splitting: false,
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

for (const file of await readdir(join(here, "static"))) {
  await copyFile(join(here, "static", file), join(out, file));
}
if (version !== undefined) {
  const manifestPath = join(out, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
await copyFile(resolve(here, "../ui/public/icon.svg"), join(out, "icon.svg"));
console.log(`built ${out}${version === undefined ? "" : ` (version ${version})`}`);
