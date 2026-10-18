import {
  CommandRunResult,
  ConfigListResult,
  ExtensionCatalogResult,
  FixtureHeader,
  type FixtureHeader as FixtureHeaderValue,
} from "@omp-app/contracts";

/**
 * Synthetic, scrubbed inputs for I2's typed seams. Catalog metadata follows A1.13's safe DTO;
 * gateway output follows A1.8's command result; settings entries follow A1.4's source/redaction
 * contract. No fixture reads an omp file or contains a private path or credential.
 */
export const I2_CATALOG_FIXTURE = ExtensionCatalogResult.parse({
  revision: "i2-catalog-revision-1",
  extensions: [
    {
      id: "demo-plugin",
      name: "Demo plugin",
      provider: "demo-marketplace",
      source: "plugin",
      version: "1.0.0",
      enabled: true,
      shadowed: false,
      capabilities: ["commands", "tools"],
      path: "plugins/demo-plugin",
      description: "Untrusted metadata stays text.",
    },
    {
      id: "unsafe-entry",
      name: "Unsafe entry",
      provider: "demo-marketplace",
      source: "extension",
      enabled: false,
      shadowed: true,
      capabilities: [],
      path: "../private-entry",
      error: "The extension could not be loaded.",
    },
    {
      id: "demo-skill",
      name: "Demo skill",
      provider: "omp-managed",
      source: "skill",
      enabled: true,
      shadowed: false,
      capabilities: [],
      path: "skills/demo-skill",
    },
  ],
  commands: [
    {
      name: "demo-command",
      provider: "demo-plugin",
      source: "plugin",
      path: "plugins/demo-plugin/commands/demo.md",
      enabled: true,
      description: "A synthetic command.",
    },
  ],
});

/** omp v18.9.1 builtin-marketplace command output after gateway normalization. */
export const I2_GATEWAY_FIXTURE = CommandRunResult.parse({
  command: "/marketplace list",
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [
    {
      text: "Marketplace: demo\nAuthorization: Bearer <REDACTED:token>\nhttps://demo.test/?token=<REDACTED:token>",
    },
  ],
  sessionUpdates: [],
  configUpdates: [],
});

export const I2_CONFIG_LIST_FIXTURE = ConfigListResult.parse({
  entries: [
    {
      key: "skills.registryUrl",
      secret: false,
      value: "https://skills.omp.sh",
      source: "default",
      overrides: [],
      provenance: { origin: "fixture", ompVersion: "18.9.1" },
    },
    {
      key: "auth.apiKey",
      secret: true,
      isSet: true,
      source: "global",
      overrides: ["default"],
      provenance: {
        origin: "fixture",
        ompVersion: "18.9.1",
        path: "<HOME>/.omp/agent/config.yml",
      },
    },
  ],
  revision: "i2-config-revision-1",
});

export const I2_INVENTORY_ROWS = [
  "C4.extensions",
  "C4.marketplace",
  "C4.plugins",
  "C4.reload-plugins",
  "C4.skills",
  "C4.skills-install",
  "C4.skills-installed",
  "C4.skills-search",
  "C4.skills-update",
  "C4.auth-gateway-stdio",
  "C4.marketplace-add",
  "C4.marketplace-discover",
  "C4.marketplace-help",
  "C4.marketplace-install",
  "C4.marketplace-installed",
  "C4.marketplace-list",
  "C4.marketplace-remove",
  "C4.marketplace-uninstall",
  "C4.marketplace-update",
  "C4.marketplace-upgrade",
  "C4.extension-control-center",
  "C4.plugin-marketplace-picker",
  "S1.plugin-settings-panel",
  "S3.interaction-skills",
] as const;

/** One scrubbed recorded-fixture header exercises the complete I2 inventory claim. */
export const I2_FIXTURE_HEADER: FixtureHeaderValue = FixtureHeader.parse({
  format: "omp-app.fixture",
  formatVersion: 1,
  scenario: "i2-extension-surfaces",
  description: "Synthetic I2 catalog, gateway and settings boundary inputs.",
  recordedAt: "2026-10-18T00:00:00.000Z",
  source: "scripted",
  omp: {
    version: "18.9.1",
    commit: "a4d6f0adc63dda4ccdf4d25c26422219820f865b",
    protocolVersion: 2,
    mode: "rpc-ui",
    args: ["--mode", "rpc-ui", "--cwd", "<WORKSPACE>"],
  },
  provider: { kind: "fake-openai" },
  capabilities: {},
  placeholders: ["<HOME>", "<WORKSPACE>"],
  redactions: { key: 0, token: 2, authHeader: 0, email: 0, path: 1 },
  tags: ["catalog", "gateway", "config", "scrubbed"],
  inventory: [...I2_INVENTORY_ROWS],
});
