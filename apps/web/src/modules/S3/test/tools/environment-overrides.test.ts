import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonValue } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { ConfigStoreService } from "../../../../../../../packages/server/src/modules/A1/config/config-store";
import { ompEnvironmentValues } from "../../../../../../../packages/server/src/modules/A1/config/omp-environment";
import type { ConfigChangeSource, ConfigStoreClient } from "../../../S1/settings-kit";
import {
  projectToolsPolicy,
  readToolsSettings,
  TOOLS_SETTING_DEFAULTS,
  ToolsSettingsStore,
} from "../../tools";

const worktreeData = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../../.data");

// Assembled at runtime so no source line looks like a real credential (the PR gate rejects those).
const TOKEN = ["tok", "x".repeat(24)].join("-");

const SAVED_GLOBAL_CONFIG = [
  "dev:",
  "  autoqa: true",
  "  autoqaPush:",
  "    endpoint: https://saved.example.test/v1",
  "tools:",
  "  intentTracing: true",
  "browser:",
  "  relay: false",
  "  cmux: true",
  "  tern: true",
  "",
].join("\n");

type Harness = {
  readonly store: ConfigStoreService;
  readonly client: ConfigStoreClient;
  readonly source: ConfigChangeSource;
  readonly configPath: string;
  readonly root: string;
};

/**
 * A real ConfigStore whose environment layer is what omp would read: the process environment
 * `environment`, plus the agent folder's `.env` when `agentDotEnv` is given. The home folder is the
 * test's own, so no real `.env` file is read.
 */
async function openHarness(
  environment: Readonly<Record<string, string>>,
  globalConfig: string,
  agentDotEnv?: string,
): Promise<Harness> {
  await mkdir(worktreeData, { recursive: true });
  const root = await mkdtemp(join(worktreeData, "s3-env-overrides-"));
  const agentDir = join(root, "agent");
  const appDataDir = join(root, "app");
  await mkdir(agentDir, { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  if (agentDotEnv !== undefined) await writeFile(join(agentDir, ".env"), agentDotEnv, "utf8");
  const configPath = join(agentDir, "config.yml");
  await writeFile(configPath, globalConfig, "utf8");
  const store = new ConfigStoreService({
    agentDir,
    appDataDir,
    homeDir: root,
    environmentValues: (folder) =>
      ompEnvironmentValues({
        processEnv: environment,
        homeDir: root,
        agentDir,
        projectDir: folder,
      }),
    watchDebounceMs: 10,
  });
  const client: ConfigStoreClient = {
    read: (args) => store.read(args),
    list: (args) => store.list(args),
    write: (args) =>
      store.write({
        ...args,
        value: args.value.secret
          ? args.value
          : { secret: false, value: JsonValue.parse(args.value.value) },
      }),
  };
  const source: ConfigChangeSource = {
    subscribe: (listener) => store.subscribe(null, listener),
  };
  return { store, client, source, configPath, root };
}

async function closeHarness(harness: Harness): Promise<void> {
  harness.store.dispose();
  await rm(harness.root, { recursive: true, force: true });
}

describe("omp environment overrides in the typed Tools policy", () => {
  test("the policy shows the environment's values and says they come from the environment", async () => {
    const harness = await openHarness(
      {
        PI_AUTO_QA: "0",
        PI_INTENT_TRACING: "0",
        PI_AUTO_QA_PUSH_URL: "https://env.example.test/v1",
        PI_BROWSER_RELAY: "1",
        PI_BROWSER_CMUX: "0",
        PI_BROWSER_TERN: "0",
      },
      SAVED_GLOBAL_CONFIG,
    );
    try {
      const policy = projectToolsPolicy(await readToolsSettings(harness.client, null));

      expect(policy.developer.autoqa).toBe(false);
      expect(policy.provenance["dev.autoqa"]).toMatchObject({
        source: "env",
        overrides: ["global"],
      });
      expect(policy.execution.intentTracing).toBe(false);
      expect(policy.provenance["tools.intentTracing"]).toMatchObject({ source: "env" });
      expect(policy.developer.autoqaPushEndpoint).toBe("https://env.example.test/v1");
      expect(policy.provenance["dev.autoqaPush.endpoint"]).toMatchObject({ source: "env" });
      expect(policy.grepBrowser).toMatchObject({ relay: true, cmux: false, tern: false });
      for (const key of ["browser.relay", "browser.cmux", "browser.tern"] as const) {
        expect(policy.provenance[key]).toMatchObject({ source: "env", overrides: ["global"] });
      }
    } finally {
      await closeHarness(harness);
    }
  });

  test("a value set only in the agent folder's .env is the value the policy shows", async () => {
    const harness = await openHarness({}, SAVED_GLOBAL_CONFIG, "PI_INTENT_TRACING=0\n");
    try {
      const policy = projectToolsPolicy(await readToolsSettings(harness.client, null));

      expect(policy.execution.intentTracing).toBe(false);
      expect(policy.provenance["tools.intentTracing"]).toMatchObject({
        source: "env",
        overrides: ["global"],
      });
    } finally {
      await closeHarness(harness);
    }
  });

  test("a saved edit is written to the file while the policy keeps the environment's value", async () => {
    const harness = await openHarness({ PI_AUTO_QA: "1" }, "dev:\n  autoqa: true\n");
    try {
      const settings = new ToolsSettingsStore(harness.client, harness.source, {
        folder: null,
        layer: "global",
      });
      await settings.read();
      expect(settings.getSnapshot().policy?.developer.autoqa).toBe(true);

      expect(settings.stage("dev.autoqa", { secret: false, value: false }).ok).toBe(true);
      await settings.save();

      expect(await readFile(harness.configPath, "utf8")).toContain("autoqa: false");
      expect(settings.getSnapshot().policy?.developer.autoqa).toBe(true);
      expect(settings.getSnapshot().policy?.provenance["dev.autoqa"]).toMatchObject({
        source: "env",
        overrides: ["global"],
      });
      settings.dispose();
    } finally {
      await closeHarness(harness);
    }
  });

  test("a credential in the environment's endpoint query is redacted and never reaches the policy", async () => {
    const url = `https://qa.example.test/v1?region=eu&token=${TOKEN}`;
    const harness = await openHarness({ PI_AUTO_QA_PUSH_URL: url }, SAVED_GLOBAL_CONFIG);
    try {
      const policy = projectToolsPolicy(await readToolsSettings(harness.client, null));

      expect(policy.redacted).toContain("dev.autoqaPush.endpoint");
      expect(policy.developer.autoqaPushEndpoint).toBe(
        TOOLS_SETTING_DEFAULTS["dev.autoqaPush.endpoint"],
      );
      expect(JSON.stringify(policy)).not.toContain(TOKEN);
    } finally {
      await closeHarness(harness);
    }
  });
});
