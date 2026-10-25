/**
 * Committed extract of omp v18.12.6's memory setting registrations (none of them changed since v18.8.9). The
 * registrations were checked against the sources: memory-backend/settings.ts:12-40, autolearn/settings.ts:10-35,
 * hindsight/settings.ts:61-157,245, and mnemopi/settings.ts:35-100,170-181,226-248; research/modules/I3.md:26-30 names
 * the settings the section covers. The app renders only these registered keys.
 */
export const MEMORY_REGISTRY_EXTRACT = {
  "memory/General": {
    controls: [
      { key: "memory.backend", values: ["off", "local", "hindsight", "mnemopi", "sharpshooter"] },
    ],
  },
  "memory/Auto-Learn": {
    controls: [
      { key: "autolearn.enabled", values: [] },
      { key: "autolearn.autoContinue", values: [] },
    ],
  },
  "memory/Hindsight": {
    controls: [
      { key: "hindsight.apiUrl", values: [] },
      { key: "hindsight.apiToken", values: [] },
      { key: "hindsight.bankId", values: [] },
      { key: "hindsight.scoping", values: ["global", "per-project", "per-project-tagged"] },
      { key: "hindsight.autoRecall", values: [] },
      { key: "hindsight.autoRetain", values: [] },
      { key: "hindsight.retainMode", values: ["full-session", "last-turn"] },
      { key: "hindsight.mentalModelsEnabled", values: [] },
      { key: "hindsight.mentalModelAutoSeed", values: [] },
    ],
  },
  "memory/Mnemopi": {
    controls: [
      { key: "mnemopi.dbPath", values: [] },
      { key: "mnemopi.bank", values: [] },
      { key: "mnemopi.scoping", values: ["global", "per-project", "per-project-tagged"] },
      { key: "mnemopi.embeddingVariant", values: ["en", "multilingual"] },
      { key: "mnemopi.autoRecall", values: [] },
      { key: "mnemopi.autoRetain", values: [] },
      { key: "mnemopi.polyphonicRecall", values: [] },
      { key: "mnemopi.enhancedRecall", values: [] },
      { key: "mnemopi.proactiveLinking", values: [] },
      { key: "mnemopi.noEmbeddings", values: [] },
      { key: "mnemopi.embeddingModel", values: [] },
      { key: "mnemopi.embeddingApiUrl", values: [] },
      { key: "mnemopi.embeddingApiKey", values: [] },
      { key: "mnemopi.llmMode", values: ["none", "smol", "remote"] },
      { key: "mnemopi.llmBaseUrl", values: [] },
      { key: "mnemopi.llmApiKey", values: [] },
      { key: "mnemopi.llmModel", values: [] },
    ],
  },
  "memory/Sharpshooter": {
    controls: [{ key: "sharpshooter.model", values: [] }],
  },
} as const;
