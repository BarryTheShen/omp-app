/**
 * Builds the extension: one script per page (the panel, the options, the toolbar button's background), the pages, the
 * manifest and the app's icon.
 * - `dist/`: Firefox and Zen (about:debugging → This Firefox → Load Temporary Add-on → its manifest.json); what Mozilla
 *   signs.
 * - `dist-chrome/` with `--chrome`: Chrome and Edge (chrome://extensions or edge://extensions → Developer mode → Load
 *   unpacked). Its manifest has a service worker and a side panel instead of background scripts and a sidebar, and PNG
 *   icons (Chrome takes no SVG icon); every script starts by naming Chrome's `chrome` as `browser`, which Chrome's
 *   promise-returning APIs serve under the same calls, and the code tells the two apart where they differ
 *   (`background.ts`, the tools' tab picture).
 *
 * `bun scripts/build.ts [version] [--chrome]`: a release passes its own version (`0.3.1527`), which goes into the
 * manifest, since Mozilla signs each version once. Without one the manifest keeps its own.
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const chrome = args.includes("--chrome");
const version = args.find((arg) => !arg.startsWith("--"));
// Firefox's form, which Chrome takes too: one to four numbers, no leading zeros.
if (version !== undefined && !/^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){0,3}$/.test(version)) {
  console.error(`"${version}" is not a version Firefox takes, such as 0.3.1527.`);
  process.exit(1);
}

const here = resolve(import.meta.dir, "..");
const out = join(here, chrome ? "dist-chrome" : "dist");
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
  ...(chrome ? { banner: "globalThis.browser ??= globalThis.chrome;" } : {}),
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

for (const file of await readdir(join(here, "static"))) {
  await copyFile(join(here, "static", file), join(out, file));
}
const manifestPath = join(out, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
if (version !== undefined) manifest.version = version;
if (chrome) {
  const sidebar = manifest.sidebar_action as { default_panel: string; default_title: string };
  delete manifest.browser_specific_settings;
  delete manifest.sidebar_action;
  manifest.background = { service_worker: "background.js", type: "module" };
  manifest.side_panel = { default_path: sidebar.default_panel };
  manifest.permissions = [...(manifest.permissions as string[]), "sidePanel"];
  manifest.icons = { "128": "icon-192.png" };
  manifest.action = {
    default_title: "omp app: open the side panel",
    default_icon: { "128": "icon-192.png" },
  };
  await copyFile(resolve(here, "../ui/public/icon-192.png"), join(out, "icon-192.png"));
} else {
  await copyFile(resolve(here, "../ui/public/icon.svg"), join(out, "icon.svg"));
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${out}${version === undefined ? "" : ` (version ${version})`}`);
