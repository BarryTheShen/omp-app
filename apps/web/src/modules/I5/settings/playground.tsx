import type {
  ConfigEntry,
  ConfigStore,
  ConfigWriteResult,
  JsonValue,
  PortClient,
  Revision,
} from "@omp-app/contracts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I5SettingsPanel } from "./panel";

const values: Readonly<Record<string, JsonValue>> = {
  "stt.enabled": false,
  "stt.submitTrigger": "never",
  "live.voice": "sol",
  "stt.language": "en",
  "tts.localVoice": "af_heart",
  "speech.enabled": true,
  "speech.mode": "assistant",
  "speech.enhanced": false,
  "speech.voice": "af_heart",
  "providers.maxInFlightRequests": { openai: 4 },
  "providers.ollama-cloud.maxConcurrency": 3,
  "providers.antigravityEndpoint": "auto",
  "providers.fetch": "auto",
  "codexResets.autoRedeem": "unset",
  "codexResets.minBlockedMinutes": 60,
  "codexResets.keepCredits": 0,
  "codexResets.salvageHorizonHours": 12,
  "claudeResets.autoRedeem": "unset",
  "claudeResets.minBlockedMinutes": 60,
  "claudeResets.keepCredits": 0,
  "claudeResets.salvageHorizonHours": 12,
  "exa.enabled": true,
  "exa.searchDelayMs": 1_000,
  "searxng.endpoint": "https://search.example.test",
};

function entries(): ConfigEntry[] {
  return (Object.entries(values) as [string, JsonValue][]).map(([key, value]) => ({
    key,
    secret: false,
    value: value as JsonValue,
    source: "global",
    overrides: ["default"],
  })) as ConfigEntry[];
}

function createClient(): PortClient<typeof ConfigStore> {
  let current = entries();
  let revision: Revision = "i5-playground-revision";
  return {
    read: async ({ key }) => {
      const entry = current.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`Missing playground key ${key}`);
      return entry;
    },
    list: async () => ({ entries: current, revision }),
    write: async (args) => {
      const entry: ConfigEntry = args.value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: args.value.action === "set",
            source: args.layer,
            overrides: [],
          }
        : {
            key: args.key,
            secret: false,
            value: args.value.value as JsonValue,
            source: args.layer,
            overrides: [],
          };
      current = [...current.filter((candidate) => candidate.key !== args.key), entry];
      const previousRevision = revision;
      revision = `${revision}-next`;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        revision,
        previousRevision,
        entry,
      } as ConfigWriteResult;
    },
    unset: async (args) => {
      current = current.filter((candidate) => candidate.key !== args.key);
      const previousRevision = revision;
      revision = `${revision}-next`;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        revision,
        previousRevision,
        entry: { key: args.key, secret: false, value: null, source: args.layer, overrides: [] },
      } as ConfigWriteResult;
    },
  };
}

const root = document.getElementById("i5-settings-playground-root");
if (!root) throw new Error("I5 settings playground root is missing.");

createRoot(root).render(
  <StrictMode>
    <I5SettingsPanel client={createClient()} folder={null} layer="global" />
  </StrictMode>,
);
