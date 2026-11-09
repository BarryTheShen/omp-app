/**
 * Builds the extension into `dist/`: one script per page (the panel, the options, the toolbar button's background), the
 * pages, the manifest and the app's icon. `dist/` is what Firefox loads (about:debugging → This Firefox → Load Temporary
 * Add-on → its manifest.json) and what Mozilla signs.
 */
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

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
await copyFile(resolve(here, "../ui/public/icon.svg"), join(out, "icon.svg"));
console.log(`built ${out}`);
