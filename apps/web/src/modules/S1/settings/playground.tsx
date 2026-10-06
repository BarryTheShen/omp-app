import type { ConfigEntry, JsonValue } from "@omp-app/contracts";
import { AppFailure, ConfigWriteArgs } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import type { ConfigChangeSource, ConfigStoreClient } from "../settings-kit";
import { useAppearanceSettingsController } from "./controller";
import { AppearanceSettingsView } from "./view";

const entries: ConfigEntry[] = [
  { key: "theme.dark", secret: false, value: "titanium", source: "default", overrides: [] },
  { key: "theme.light", secret: false, value: "light", source: "default", overrides: [] },
  { key: "symbolPreset", secret: false, value: "unicode", source: "default", overrides: [] },
  { key: "colorBlindMode", secret: false, value: false, source: "default", overrides: [] },
  { key: "composer.shape", secret: false, value: "band", source: "default", overrides: [] },
  { key: "composer.tokenRate", secret: false, value: false, source: "default", overrides: [] },
  { key: "statusLine.preset", secret: false, value: "default", source: "default", overrides: [] },
  {
    key: "statusLine.separator",
    secret: false,
    value: "powerline-thin",
    source: "default",
    overrides: [],
  },
  {
    key: "statusLine.contextLine",
    secret: false,
    value: "embedded",
    source: "default",
    overrides: [],
  },
  {
    key: "display.hideToolActivity",
    secret: false,
    value: false,
    source: "default",
    overrides: [],
  },
  { key: "display.showTokenUsage", secret: false, value: false, source: "default", overrides: [] },
  { key: "display.showTurnTime", secret: false, value: false, source: "default", overrides: [] },
  { key: "display.cacheMissMarker", secret: false, value: false, source: "default", overrides: [] },
  {
    key: "display.collapseCompacted",
    secret: false,
    value: true,
    source: "default",
    overrides: [],
  },
  { key: "terminal.showImages", secret: false, value: true, source: "default", overrides: [] },
  { key: "images.autoResize", secret: false, value: true, source: "default", overrides: [] },
  { key: "images.blockImages", secret: false, value: false, source: "default", overrides: [] },
];
let revision = "revision-1";

const client: ConfigStoreClient = {
  async read({ key }) {
    const entry = entries.find((candidate) => candidate.key === key);
    if (!entry) {
      throw new AppFailure({
        code: "not_found",
        message: "Configuration key was not found.",
        retryable: false,
      });
    }
    return entry;
  },
  async list() {
    return { entries, revision };
  },
  async write(input) {
    const write = ConfigWriteArgs.parse(input);
    if (write.expectedRevision !== revision) {
      throw new AppFailure({
        code: "conflict",
        message: "Configuration changed elsewhere.",
        retryable: true,
      });
    }
    if (write.value.secret) throw new Error("The playground does not accept secret writes.");
    const previousRevision = revision;
    revision = `revision-${Number(revision.split("-").at(-1)) + 1}`;
    const entry: ConfigEntry = {
      key: write.key,
      secret: false,
      value: write.value.value as JsonValue,
      source: write.layer,
      overrides: ["default"],
    };
    const index = entries.findIndex((candidate) => candidate.key === write.key);
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    return {
      key: write.key,
      layer: write.layer,
      folder: write.folder,
      previousRevision,
      revision,
      entry,
    };
  },
};

const changes: ConfigChangeSource = { subscribe: () => () => {} };

function AppearanceSettingsPlayground() {
  const { model, actions } = useAppearanceSettingsController({
    client,
    changes,
    folder: null,
    layer: "global",
  });
  return <AppearanceSettingsView model={model} actions={actions} onClose={() => undefined} />;
}

const root = document.getElementById("appearance-settings-playground-root");
if (!root) throw new Error("Appearance settings playground root is missing.");

createRoot(root).render(<AppearanceSettingsPlayground />);
