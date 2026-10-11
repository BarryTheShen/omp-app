/** The provider omp's catalog gives items in its own extensions and skills folders. */
const NATIVE_PROVIDER = "native";
/** The provider the catalog gives skills that omp manages itself. */
const OMP_MANAGED_PROVIDER = "omp-managed";
/** The providers the server and the catalog use when they cannot name the provider. */
const UNKNOWN_PROVIDERS: ReadonlySet<string> = new Set(["unknown", "unknown-provider"]);

const FROM_EXTENSIONS_FOLDER = "From your extensions folder";
const FROM_SKILLS_FOLDER = "From your skills folder";
const FROM_PLUGIN = "From a plugin";
const MANAGED_BY_OMP = "Managed by omp";
const SOURCE_NOT_KNOWN = "Source not known";

/**
 * Where an item came from, in words a person reads. The catalog's source kinds are extension, plugin
 * and skill. For a skill the provider says whether it sits in omp's own folder, is managed by omp, or
 * comes from a plugin's package (any other provider name is that package). A plugin always comes from
 * a plugin. The raw provider name is never returned: it stays in the item's details.
 */
export function itemOriginText(item: {
  readonly source: string;
  readonly provider: string;
}): string {
  if (UNKNOWN_PROVIDERS.has(item.provider)) return SOURCE_NOT_KNOWN;
  switch (item.source) {
    case "extension":
      return item.provider === NATIVE_PROVIDER ? FROM_EXTENSIONS_FOLDER : SOURCE_NOT_KNOWN;
    case "plugin":
      return FROM_PLUGIN;
    case "skill":
      if (item.provider === NATIVE_PROVIDER) return FROM_SKILLS_FOLDER;
      if (item.provider === OMP_MANAGED_PROVIDER) return MANAGED_BY_OMP;
      return FROM_PLUGIN;
    default:
      return SOURCE_NOT_KNOWN;
  }
}
