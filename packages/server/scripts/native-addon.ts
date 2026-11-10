/**
 * omp's native addon (`@oh-my-pi/pi-natives`), embedded in a compiled program as omp's own binaries embed it
 * (`natives/scripts/embed-native.ts` at v18.18.5, `embeddedAddonFiles`). A compiled program finds the addon only
 * embedded, and extracts it into omp's natives folder (`~/.omp/natives/<version>/`) the first time it loads it. Both
 * compiled programs of the app embed it: the chat host (`build-chat-host.ts`), and the app's command (`build-server.ts`),
 * whose browser relay server (omp's `tools/browser/relay/server`) loads the addon as it is imported since omp 18.18.
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The platform the packages ship for; omp embeds the addons of the target it compiles. */
export const PLATFORM_TAG = "linux-x64";

/**
 * The files `Bun.build` takes in place of pi-natives' own (its `files` option): one zstd frame per addon variant, and a
 * replacement for pi-natives' null `native/embedded-addon.js` manifest that points at them. `fromDir` is a folder that
 * resolves the `@oh-my-pi/pi-natives` the bundle resolves; the keys are its symlink-resolved `native/` folder, which the
 * bundler resolves. The addons come from the platform package.
 */
export async function embeddedNativeAddon(
  fromDir: string,
): Promise<Record<string, string | Uint8Array>> {
  const nativeDir = await realpath(dirname(Bun.resolveSync("@oh-my-pi/pi-natives", fromDir)));
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
