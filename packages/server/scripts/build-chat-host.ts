/**
 * Compiles the chat host: omp's own command line (`@oh-my-pi/pi-coding-agent` `src/cli.ts`, the release package.json
 * pins), the way omp compiles its binary (18.12.6 `scripts/compile-binary.ts`, `compileCodingAgent`):
 * - precompiled bytecode, code splitting, names kept, omp's JSON-parse plugin and fetch user agent;
 * - omp's build constants: `PI_COMPILED`, `PI_DOCS_EMBED` (the package's shipped docs index) and
 *   `PI_TINY_TRANSFORMERS_VERSION` (the installed `@huggingface/transformers`);
 * - the native addon embedded, as omp's `natives/scripts/embed-native.ts` does, read from the installed
 *   `@oh-my-pi/pi-natives-linux-x64`, and the stats dashboard embedded, as omp's `gen:stats` does;
 * - omp's legacy-module registry (`omp-legacy-pi-modules`), which a compiled omp loads before any extension: built from
 *   the installed packages, as omp's `scripts/legacy-pi-virtual-module.ts` builds it from its monorepo;
 * - on the Bun omp's release is built with. On the test machine's Bun 1.3.14 each chat kept about 130 MB more memory (SDK plan, H0).
 *
 * The server runs it as it ran omp's binary, `<chat host> --mode rpc-ui <arguments>` (`src/omp-host/chat-command.ts`).
 * omp's worker threads and subprocesses re-enter the same program with an argv selector of their own, which omp's entry
 * dispatches, so the program is omp's entry itself.
 *
 *   <that Bun> packages/server/scripts/build-chat-host.ts <outfile>
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CHAT_HOST_BUN_VERSION } from "./chat-host-bun";

if (Bun.version !== CHAT_HOST_BUN_VERSION) {
  console.error(
    `The chat host is compiled with Bun ${CHAT_HOST_BUN_VERSION}, the Bun omp's release is built with; this is Bun ${Bun.version}. Run this script with that Bun (CHAT_HOST_BUN in packaging/build-deb.sh).`,
  );
  process.exit(1);
}

/** The platform the packages ship for; omp embeds the addons of the target it compiles. */
const PLATFORM_TAG = "linux-x64";

// The package's exports map only `./src/*`, so its folder is found from one of them.
const packageDir = dirname(
  dirname(Bun.resolveSync("@oh-my-pi/pi-coding-agent/cli", import.meta.dir)),
);
const fromOmp = createRequire(join(packageDir, "package.json"));
const { createJsonParsePlugin } = (await import(
  join(packageDir, "scripts/json-parse-plugin.ts")
)) as { createJsonParsePlugin: () => Bun.BunPlugin };
const { USER_AGENT } = (await import(Bun.resolveSync("@oh-my-pi/pi-utils/dirs", packageDir))) as {
  USER_AGENT: string;
};

const transformers: unknown = fromOmp("@huggingface/transformers/package.json");
if (
  typeof transformers !== "object" ||
  transformers === null ||
  !("version" in transformers) ||
  typeof transformers.version !== "string"
) {
  throw new Error("@huggingface/transformers package manifest has no string version");
}
// The docs index the package ships for SDK users; omp's build inlines the same payload.
const docsEmbed = await readFile(join(packageDir, "dist/docs-index.generated.txt"), "utf8");

/**
 * omp's `embeddedAddonFiles` (`natives/scripts/embed-native.ts` at v18.12.6): one zstd frame per addon variant, and a
 * replacement for pi-natives' null `native/embedded-addon.js` manifest that points at them. The keys are pi-natives'
 * symlink-resolved `native/` folder, which the bundler resolves; the addons come from the platform package.
 */
async function embeddedNativeAddon(): Promise<Record<string, string | Uint8Array>> {
  const nativeDir = await realpath(dirname(Bun.resolveSync("@oh-my-pi/pi-natives", packageDir)));
  const { version } = JSON.parse(await readFile(join(nativeDir, "../package.json"), "utf8")) as {
    version: string;
  };
  const sentinel = (await import(join(nativeDir, "version-sentinel.js"))) as {
    containsVersionStamp: (bytes: Uint8Array, version: string) => boolean;
    containsLegacyVersionSentinel: (bytes: Uint8Array, version: string) => boolean;
  };
  const addonDir = dirname(
    Bun.resolveSync(`@oh-my-pi/pi-natives-${PLATFORM_TAG}/package.json`, nativeDir),
  );
  const present = new Set(await readdir(addonDir));
  const addons = await Promise.all(
    [
      { variant: "modern", filename: `pi_natives.${PLATFORM_TAG}-modern.node` },
      { variant: "baseline", filename: `pi_natives.${PLATFORM_TAG}-baseline.node` },
    ]
      .filter((addon) => present.has(addon.filename))
      .map(async (addon) => ({
        ...addon,
        bytes: new Uint8Array(await readFile(join(addonDir, addon.filename))),
      })),
  );
  if (addons.length === 0) throw new Error(`No native addon for ${PLATFORM_TAG} in ${addonDir}`);
  for (const { filename, bytes } of addons) {
    if (
      !sentinel.containsVersionStamp(bytes, version) &&
      !sentinel.containsLegacyVersionSentinel(bytes, version)
    ) {
      throw new Error(`${join(addonDir, filename)} is not stamped @oh-my-pi/pi-natives@${version}`);
    }
  }
  const frames = await Promise.all(
    addons.map(({ bytes }) => Bun.zstdCompress(bytes, { level: 19 })),
  );
  const imports = addons.map(
    ({ filename }, index) =>
      `import zstdPath${index} from ${JSON.stringify(`./${filename}.zst`)} with { type: "file" };`,
  );
  const files = addons.map(
    ({ variant, filename, bytes }, index) =>
      `{ variant: ${JSON.stringify(variant)}, filename: ${JSON.stringify(filename)}, size: ${bytes.length}, zstdPath: zstdPath${index} }`,
  );
  const overrides: Record<string, string | Uint8Array> = {
    [join(nativeDir, "embedded-addon.js")]:
      `${imports.join("\n")}\n\nexport const embeddedAddon = {\n\tplatformTag: ${JSON.stringify(PLATFORM_TAG)},\n\tversion: ${JSON.stringify(version)},\n\tfiles: [\n\t\t${files.join(",\n\t\t")},\n\t],\n};\n`,
  };
  addons.forEach(({ filename }, index) => {
    const frame = frames[index];
    if (frame !== undefined) overrides[join(nativeDir, `${filename}.zst`)] = frame;
  });
  return overrides;
}

/**
 * The stats dashboard, embedded as omp's build does (`stats/scripts/generate-client-bundle.ts` at v18.12.6, run by
 * `gen:stats`): the base64 of a gzipped tar of its built files, in place of the package's empty
 * `src/embedded-client.generated.txt`. A compiled omp serves the dashboard only from it. The npm package ships the
 * built files (`dist/client`), so they are archived here. (omp also zeroes each entry's mtime, so its builds are
 * byte-identical; the dashboard does not read them.)
 */
async function embeddedStatsDashboard(): Promise<Record<string, string>> {
  // The keys must be the symlink-resolved paths the bundler resolves, as for the native addon.
  const statsDir = await realpath(
    dirname(Bun.resolveSync("@oh-my-pi/omp-stats/package.json", packageDir)),
  );
  const clientDir = join(statsDir, "dist/client");
  const names = (await readdir(clientDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(clientDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  if (!names.includes("index.html")) throw new Error(`No built stats dashboard in ${clientDir}`);
  const entries: Record<string, Uint8Array> = {};
  for (const name of names) entries[name] = await Bun.file(join(clientDir, name)).bytes();
  const tar = await new Bun.Archive(entries).bytes();
  return {
    [join(statsDir, "src/embedded-client.generated.txt")]: Buffer.from(
      Bun.gzipSync(tar, { level: 9 }),
    ).toString("base64"),
  };
}

/**
 * omp's packages in its legacy-module registry, as `BUNDLED_PACKAGES` in its `scripts/legacy-pi-virtual-module.ts` at
 * v18.12.6 names them by monorepo folder (agent, ai, catalog, coding-agent, natives, tui, utils).
 */
const LEGACY_PI_PACKAGES = [
  {
    name: "@oh-my-pi/pi-agent-core",
    identifier: "PiAgentCore",
    rootShim: null,
    rootWildcard: null,
  },
  {
    name: "@oh-my-pi/pi-ai",
    identifier: "PiAi",
    rootShim: "legacy-pi-ai-shim.ts",
    rootWildcard: null,
  },
  { name: "@oh-my-pi/pi-catalog", identifier: "PiCatalog", rootShim: null, rootWildcard: "flat" },
  {
    name: "@oh-my-pi/pi-coding-agent",
    identifier: "PiCodingAgent",
    rootShim: "legacy-pi-coding-agent-shim.ts",
    rootWildcard: null,
  },
  { name: "@oh-my-pi/pi-natives", identifier: "PiNatives", rootShim: null, rootWildcard: null },
  {
    name: "@oh-my-pi/pi-tui",
    identifier: "PiTui",
    rootShim: "legacy-pi-tui-shim.ts",
    rootWildcard: "nested",
  },
  { name: "@oh-my-pi/pi-utils", identifier: "PiUtils", rootShim: null, rootWildcard: null },
] as const;

function bindingForSubpath(identifier: string, subpath: string): string {
  const segments = subpath
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(""),
    );
  return `bundled${identifier}${segments.join("")}`;
}

function isSafeWildcardBasename(basename: string): boolean {
  if (!basename || basename.startsWith(".") || basename.startsWith("_")) return false;
  if (basename === "worker-entry") return false;
  return !/\.(test|spec|d|d\.json|generated|bench)$/.test(basename);
}

/**
 * The registry module: one lazy loader per key, as omp's `collectBundledPiEntries` and `__renderLegacyPiVirtualModule`
 * make it, with each package read from its installed folder. Every import is resolved here to a file, so the module
 * needs no resolution context of its own.
 */
async function legacyPiModulesSource(): Promise<string> {
  const entries: { key: string; binding: string; file: string }[] = [];
  const seen = new Set<string>();
  const add = (key: string, binding: string, specifier: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const file = specifier.startsWith("/") ? specifier : Bun.resolveSync(specifier, packageDir);
    entries.push({ key, binding, file });
  };
  const shim = (file: string): string => join(packageDir, "src/extensibility", file);
  for (const pkg of LEGACY_PI_PACKAGES) {
    const packageRoot = await realpath(
      dirname(Bun.resolveSync(`${pkg.name}/package.json`, packageDir)),
    );
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const exportsField = manifest.exports ?? {};
    add(pkg.name, `bundled${pkg.identifier}`, pkg.rootShim ? shim(pkg.rootShim) : pkg.name);
    for (const exportKey of Object.keys(exportsField)) {
      if (!exportKey.startsWith("./") || exportKey === "." || exportKey.includes("*")) continue;
      const subpath = exportKey.slice(2);
      add(
        `${pkg.name}/${subpath}`,
        bindingForSubpath(pkg.identifier, subpath),
        `${pkg.name}/${subpath}`,
      );
    }
    for (const [exportKey, target] of Object.entries(exportsField)) {
      if (!exportKey.startsWith("./") || exportKey === "." || !exportKey.includes("*")) continue;
      const sourcePattern =
        typeof target === "string"
          ? target
          : typeof target === "object" && target !== null && "import" in target
            ? String(target.import)
            : undefined;
      const exportStar = exportKey.indexOf("*");
      const sourceStar = sourcePattern?.indexOf("*") ?? -1;
      if (sourcePattern === undefined || !sourcePattern.startsWith("./") || sourceStar === -1)
        continue;
      if (
        exportKey.indexOf("*", exportStar + 1) !== -1 ||
        sourcePattern.indexOf("*", sourceStar + 1) !== -1
      )
        continue;
      const exportPrefix = exportKey.slice(2, exportStar);
      const exportSuffix = exportKey.slice(exportStar + 1);
      const sourcePrefix = sourcePattern.slice(2, sourceStar);
      const sourceSuffix = sourcePattern.slice(sourceStar + 1);
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(sourceSuffix)) continue;
      const rootWildcard = exportPrefix === "" || exportPrefix === "/";
      if (rootWildcard && (exportKey !== "./*" || !pkg.rootWildcard)) continue;
      const matches: string[] = [];
      try {
        for await (const match of new Bun.Glob(`**/*${sourceSuffix}`).scan({
          cwd: join(packageRoot, sourcePrefix),
          onlyFiles: true,
        })) {
          matches.push(match.split(sep).join("/"));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const match of matches.sort()) {
        if (!match.endsWith(sourceSuffix)) continue;
        if (rootWildcard && pkg.rootWildcard === "flat" && match.includes("/")) continue;
        const basename = match.slice(0, match.length - sourceSuffix.length);
        const segments = basename.split("/");
        if (segments.some((segment) => segment.startsWith(".") || segment.startsWith("_")))
          continue;
        if (!isSafeWildcardBasename(segments.at(-1) ?? "")) continue;
        const subpath = `${exportPrefix}${basename}${exportSuffix}`;
        add(
          `${pkg.name}/${subpath}`,
          bindingForSubpath(pkg.identifier, subpath),
          `${pkg.name}/${subpath}`,
        );
      }
    }
  }
  add("typebox", "bundledTypeBoxShim", shim("legacy-typebox.ts"));
  const loaders = entries.map(
    (entry) => `const ${entry.binding} = () => import(${JSON.stringify(entry.file)});`,
  );
  const modules = entries.map((entry) => `\t${JSON.stringify(entry.key)}: ${entry.binding},`);
  return [...loaders, "", "export const BUNDLED_PI_MODULE_LOADERS = {", ...modules, "};", ""].join(
    "\n",
  );
}

/** omp's `createLegacyPiVirtualModulePlugin`, over the registry built above. */
async function legacyPiModulesPlugin(): Promise<Bun.BunPlugin> {
  const source = await legacyPiModulesSource();
  return {
    name: "omp:legacy-pi-modules",
    setup(build) {
      build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
        path: "omp-legacy-pi-modules",
        namespace: "omp-legacy-pi-modules-build",
      }));
      build.onLoad({ filter: /.*/, namespace: "omp-legacy-pi-modules-build" }, () => ({
        contents: source,
        loader: "ts",
      }));
    },
  };
}

const outfile = resolve(process.argv[2] ?? "chat-host");
const output = await Bun.build({
  entrypoints: [join(packageDir, "src/cli.ts")],
  // omp's own (COMPILED_EXTERNAL_DEPENDENCIES): native runtime dependencies come from omp's on-demand install.
  external: ["fastembed", "onnxruntime-node"],
  files: { ...(await embeddedNativeAddon()), ...(await embeddedStatsDashboard()) },
  define: {
    "process.env.PI_COMPILED": JSON.stringify("true"),
    "process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(transformers.version),
    "process.env.PI_DOCS_EMBED": JSON.stringify(docsEmbed),
  },
  format: "esm",
  bytecode: true,
  splitting: true,
  naming: { chunk: "chunks/[name]-[hash].[ext]" },
  minify: { identifiers: false, keepNames: true },
  plugins: [createJsonParsePlugin(), await legacyPiModulesPlugin()],
  compile: {
    execArgv: [`--user-agent=${USER_AGENT}`],
    outfile,
    target: "bun-linux-x64",
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  throw: false,
});
if (!output.success) {
  console.error(output.logs.map((log) => log.message).join("\n"));
  process.exit(1);
}
console.log(`chat host compiled: ${outfile}`);
