import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigStoreService } from "./config-store";
import {
  type OmpEnvironmentSources,
  ompEnvironmentValues,
  ompEnvironmentVariableNames,
} from "./omp-environment";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-env-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Sources whose home, config and agent folders all sit inside `root`, so no real `.env` is read. */
function sourcesIn(
  root: string,
  overrides: Partial<OmpEnvironmentSources> = {},
): OmpEnvironmentSources {
  return {
    processEnv: {},
    homeDir: join(root, "home"),
    agentDir: join(root, "agent"),
    projectDir: null,
    ...overrides,
  };
}

// Assembled at runtime so no source line looks like a real credential (the PR gate rejects those).
const TOKEN = ["tok", "x".repeat(24)].join("-");

describe("ompEnvironmentValues", () => {
  test("reads flags with omp's spellings: listed texts are on, any other text is off", async () => {
    const root = await temporaryRoot();
    expect(
      await ompEnvironmentValues(
        sourcesIn(root, {
          processEnv: {
            PI_AUTO_QA: "1",
            PI_INTENT_TRACING: "yes",
            PI_BROWSER_RELAY: "ON",
            PI_BROWSER_CMUX: "0",
            PI_BROWSER_TERN: "no",
          },
        }),
      ),
    ).toEqual({
      "dev.autoqa": true,
      "tools.intentTracing": true,
      "browser.relay": true,
      "browser.cmux": false,
      "browser.tern": false,
    });
    // omp matches these spellings exactly (packages/utils/src/env.ts:472-487): "True" is not on.
    expect(
      await ompEnvironmentValues(
        sourcesIn(root, { processEnv: { PI_AUTO_QA: "garbage", PI_INTENT_TRACING: "True" } }),
      ),
    ).toEqual({ "dev.autoqa": false, "tools.intentTracing": false });
  });

  test("leaves a setting out when no source sets its variable, so the saved value applies", async () => {
    const root = await temporaryRoot();
    expect(await ompEnvironmentValues(sourcesIn(root))).toEqual({});
    expect(
      await ompEnvironmentValues(
        sourcesIn(root, { processEnv: { PI_AUTO_QA: "", PI_AUTO_QA_PUSH_URL: "   " } }),
      ),
    ).toEqual({});
  });

  test("reads the push URL trimmed as the endpoint omp pushes to", async () => {
    const root = await temporaryRoot();
    expect(
      await ompEnvironmentValues(
        sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_URL: "  https://qa.example.test/v1  " } }),
      ),
    ).toEqual({ "dev.autoqaPush.endpoint": "https://qa.example.test/v1" });
  });

  test("a value set only in the agent folder's .env is the value omp uses", async () => {
    const root = await temporaryRoot();
    await writeText(join(root, "agent", ".env"), "PI_AUTO_QA=0\n");
    expect(await ompEnvironmentValues(sourcesIn(root))).toEqual({ "dev.autoqa": false });
  });

  test("the process environment beats every .env file, and an empty one falls through", async () => {
    const root = await temporaryRoot();
    await writeText(join(root, "agent", ".env"), "PI_AUTO_QA=0\nPI_INTENT_TRACING=0\n");
    expect(
      await ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA: "1" } })),
    ).toEqual({ "dev.autoqa": true, "tools.intentTracing": false });
    expect(await ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA: "" } }))).toEqual(
      { "dev.autoqa": false, "tools.intentTracing": false },
    );
  });

  test("a whitespace-only process value counts as set, so it blocks the files", async () => {
    const root = await temporaryRoot();
    await writeText(
      join(root, "agent", ".env"),
      "PI_AUTO_QA_PUSH_URL=https://file.example.test/v1\n",
    );
    // omp reads a whitespace value as set (env.ts:300-303), so the file is not used; trimmed, it is empty.
    expect(
      await ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_URL: "  " } })),
    ).toEqual({});
  });

  test("the .env files beat each other in omp's order: project, agent folder, config folder, home", async () => {
    const root = await temporaryRoot();
    const project = join(root, "project");
    await writeText(join(root, "home", ".env"), "PI_INTENT_TRACING=1\n");
    await writeText(join(root, "home", ".omp", ".env"), "PI_INTENT_TRACING=1\n");
    await writeText(join(root, "agent", ".env"), "PI_INTENT_TRACING=1\n");
    await writeText(join(project, ".env"), "PI_INTENT_TRACING=0\n");
    const inProject = sourcesIn(root, { projectDir: project });
    expect(await ompEnvironmentValues(inProject)).toEqual({ "tools.intentTracing": false });

    // Without the project file, the agent folder's file is next.
    await writeText(join(root, "agent", ".env"), "PI_INTENT_TRACING=0\n");
    await writeText(join(project, ".env"), "PI_INTENT_TRACING=\n");
    expect(await ompEnvironmentValues(inProject)).toEqual({ "tools.intentTracing": false });

    // An empty agent file falls through to the config folder, which is next after it.
    await writeText(join(root, "agent", ".env"), "PI_INTENT_TRACING=\n");
    await writeText(join(root, "home", ".omp", ".env"), "PI_INTENT_TRACING=0\n");
    await writeText(join(root, "home", ".env"), "PI_INTENT_TRACING=1\n");
    expect(await ompEnvironmentValues(inProject)).toEqual({ "tools.intentTracing": false });

    // The home folder's file is read last.
    await writeText(join(root, "home", ".omp", ".env"), "");
    expect(await ompEnvironmentValues(inProject)).toEqual({ "tools.intentTracing": true });
  });

  test("a project's .env applies only when a project is in view", async () => {
    const root = await temporaryRoot();
    const project = join(root, "project");
    await writeText(join(project, ".env"), "PI_AUTO_QA=0\n");
    expect(await ompEnvironmentValues(sourcesIn(root))).toEqual({});
    expect(await ompEnvironmentValues(sourcesIn(root, { projectDir: project }))).toEqual({
      "dev.autoqa": false,
    });
  });

  test("OMP_ names in a file also set their PI_ name, and win inside that file", async () => {
    const root = await temporaryRoot();
    await writeText(join(root, "agent", ".env"), "PI_AUTO_QA=1\nOMP_AUTO_QA=0\n");
    expect(await ompEnvironmentValues(sourcesIn(root))).toEqual({ "dev.autoqa": false });
  });

  test("with an active profile, omp reads the profile's config and agent folders", async () => {
    const root = await temporaryRoot();
    const profileAgent = join(root, "home", ".omp", "profiles", "work", "agent");
    await writeText(join(profileAgent, ".env"), "PI_AUTO_QA=0\n");
    await writeText(join(root, "agent", ".env"), "PI_AUTO_QA=1\n");
    expect(
      await ompEnvironmentValues(sourcesIn(root, { processEnv: { OMP_PROFILE: "work" } })),
    ).toEqual({ "dev.autoqa": false });
  });

  test("reads the push token from PI_AUTO_QA_PUSH_TOKEN, trimmed, as the token omp pushes with", async () => {
    const root = await temporaryRoot();
    expect(
      await ompEnvironmentValues(
        sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_TOKEN: `  ${TOKEN}  ` } }),
      ),
    ).toEqual({ "dev.autoqaPush.token": TOKEN });
    expect(
      await ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_TOKEN: "  " } })),
    ).toEqual({});
  });
});

describe("omp environment values in the ConfigStore", () => {
  test("a project's .env applies to reads in that project and not to global reads", async () => {
    const root = await temporaryRoot();
    const project = join(root, "project");
    await writeText(join(project, ".env"), "PI_AUTO_QA=0\n");
    const store = new ConfigStoreService({
      agentDir: join(root, "agent"),
      appDataDir: join(root, "app"),
      environmentValues: (folder) => ompEnvironmentValues(sourcesIn(root, { projectDir: folder })),
    });
    expect(await store.read({ key: "dev.autoqa", folder: project })).toMatchObject({
      value: false,
      source: "env",
    });
    expect((await store.list({ folder: null })).entries).toEqual([]);
    store.dispose();
  });

  test("hides an environment URL whose query carries a credential, in reads and lists", async () => {
    const root = await temporaryRoot();
    const url = `https://qa.example.test/v1?region=eu&token=${TOKEN}`;
    const store = new ConfigStoreService({
      agentDir: join(root, "agent"),
      appDataDir: join(root, "app"),
      environmentValues: () =>
        ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_URL: url } })),
    });
    const read = await store.read({ key: "dev.autoqaPush.endpoint", folder: null });
    expect(read).toMatchObject({
      key: "dev.autoqaPush.endpoint",
      secret: true,
      isSet: true,
      source: "env",
    });
    expect(JSON.stringify(read)).not.toContain(TOKEN);
    expect(JSON.stringify(await store.list({ folder: null }))).not.toContain(TOKEN);
    store.dispose();
  });

  // A credential sits only in a URL's query, fragment or userinfo, so an endpoint with any of them is hidden, whatever
  // the parameter is named or how it is written. A query without a credential is hidden too: the rule is structural.
  const hiddenEndpoints = [
    ...[
      "token",
      "api_key",
      "X-Auth-Token",
      "access_token",
      "id_token",
      "client_secret",
      "private_key",
      "x-api-key",
      "password",
      "secret",
      "auth",
      "key",
      "sig",
      "signature",
      "apiKey",
      "apikey",
      "accessToken",
      "authorization",
      "Authorization",
      "bearer",
      "jwt",
      "credential",
      "credentials",
      "pwd",
      "passwd",
      "pass",
      "secretKey",
      "sessionid",
      "session",
      "code",
      "sas",
      "apitoken",
      "authtoken",
      "key_id",
    ].map((name) => `https://qa.example.test/v1?${name}=${TOKEN}`),
    `https://qa.example.test/v1?%74oken=${TOKEN}`,
    `https://qa.example.test/v1?token%3D${TOKEN}`,
    `https://qa.example.test/v1?region=eu&amp;token=${TOKEN}`,
    `https://qa.example.test/v1?region=eu;token=${TOKEN}`,
    `https://qa.example.test/v1? token=${TOKEN}`,
    `https://qa.example.test/v1#access_token=${TOKEN}`,
    `https://${TOKEN}@qa.example.test/v1`,
    `https://user:${TOKEN}@qa.example.test/v1`,
    `qa.example.test/v1?apiKey=${TOKEN}`,
    "https://qa.example.test/v1?region=eu",
  ];
  const plainEndpoints = [
    "https://qa.example.test/v1",
    "https://qa.example.test/v1/",
    "https://qa.omp.sh/v1/grievances",
  ];

  test.each(hiddenEndpoints)(
    "hides the push endpoint %s when the environment sets it",
    async (url) => {
      const root = await temporaryRoot();
      const store = new ConfigStoreService({
        agentDir: join(root, "agent"),
        appDataDir: join(root, "app"),
        environmentValues: () =>
          ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_URL: url } })),
      });
      const read = await store.read({ key: "dev.autoqaPush.endpoint", folder: null });
      expect(read).toMatchObject({
        key: "dev.autoqaPush.endpoint",
        secret: true,
        isSet: true,
        source: "env",
      });
      expect(JSON.stringify(read)).not.toContain(TOKEN);
      expect(JSON.stringify(await store.list({ folder: null }))).not.toContain(TOKEN);
      store.dispose();
    },
  );

  test.each(hiddenEndpoints)("hides the push endpoint %s when it is saved", async (url) => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await writeText(
      join(agent, "config.yml"),
      `dev:\n  autoqaPush:\n    endpoint: ${JSON.stringify(url)}\n`,
    );
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const saved = await store.read({ key: "dev.autoqaPush.endpoint", folder: null });
    expect(saved).toMatchObject({ secret: true, isSet: true, source: "global" });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(await store.list({ folder: null }))).not.toContain(TOKEN);
    expect(JSON.stringify(await store.read({ key: "dev", folder: null }))).not.toContain(TOKEN);
    store.dispose();
  });

  test.each(plainEndpoints)(
    "shows the plain push endpoint %s, from the environment and when saved",
    async (url) => {
      const root = await temporaryRoot();
      const fromEnvironment = new ConfigStoreService({
        agentDir: join(root, "agent"),
        appDataDir: join(root, "app"),
        environmentValues: () =>
          ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_URL: url } })),
      });
      expect(
        await fromEnvironment.read({ key: "dev.autoqaPush.endpoint", folder: null }),
      ).toMatchObject({
        secret: false,
        value: url,
        source: "env",
      });
      fromEnvironment.dispose();
      const agent = join(root, "saved");
      await writeText(
        join(agent, "config.yml"),
        `dev:\n  autoqaPush:\n    endpoint: ${JSON.stringify(url)}\n`,
      );
      const saved = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
      expect(await saved.read({ key: "dev.autoqaPush.endpoint", folder: null })).toMatchObject({
        secret: false,
        value: url,
        source: "global",
      });
      saved.dispose();
    },
  );

  test("shows a shell prefix with a credential-named flag: the endpoint rule applies to the push endpoint only", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await writeText(
      join(agent, "config.yml"),
      `bash:\n  prefix: ${JSON.stringify("cd /tmp && make --key=1")}\n`,
    );
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    expect(await store.read({ key: "bash.prefix", folder: null })).toMatchObject({
      secret: false,
      value: "cd /tmp && make --key=1",
    });
    store.dispose();
  });

  test("a saved edit to a hidden environment URL is written to the file, and the value stays hidden", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    const url = `https://qa.example.test/v1?token=${TOKEN}`;
    const store = new ConfigStoreService({
      agentDir: agent,
      appDataDir: join(root, "app"),
      environmentValues: () =>
        ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_URL: url } })),
    });
    const revision = (await store.list({ folder: null })).revision;
    const written = await store.write({
      key: "dev.autoqaPush.endpoint",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: false, value: "https://saved.example.test/v1" },
    });
    expect(written.entry).toMatchObject({ secret: true, source: "env" });
    expect(await readFile(join(agent, "config.yml"), "utf8")).toContain("saved.example.test");
    store.dispose();
  });

  test("beats project, global and default values, and reports the environment as the source", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    const project = join(root, "project");
    await writeText(
      join(agent, "config.yml"),
      [
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
      ].join("\n"),
    );
    await writeText(
      join(project, ".omp", "config.yml"),
      "tools:\n  intentTracing: true\nbrowser:\n  tern: true\n",
    );
    const store = new ConfigStoreService({
      agentDir: agent,
      appDataDir: join(root, "app"),
      defaultValues: {
        "dev.autoqa": true,
        "dev.autoqaPush.endpoint": "https://qa.omp.sh/v1/grievances",
        "tools.intentTracing": true,
        "browser.relay": false,
        "browser.cmux": true,
        "browser.tern": true,
      },
      environmentValues: (folder) =>
        ompEnvironmentValues(
          sourcesIn(root, {
            processEnv: {
              PI_AUTO_QA: "0",
              PI_AUTO_QA_PUSH_URL: "https://env.example.test/v1",
              PI_INTENT_TRACING: "0",
              PI_BROWSER_RELAY: "1",
              PI_BROWSER_CMUX: "0",
              PI_BROWSER_TERN: "0",
            },
            projectDir: folder,
          }),
        ),
    });

    expect(await store.read({ key: "dev.autoqa", folder: project })).toMatchObject({
      value: false,
      source: "env",
      overrides: ["global", "default"],
    });
    expect(await store.read({ key: "dev.autoqaPush.endpoint", folder: project })).toMatchObject({
      value: "https://env.example.test/v1",
      source: "env",
      overrides: ["global", "default"],
    });
    expect(await store.read({ key: "tools.intentTracing", folder: project })).toMatchObject({
      value: false,
      source: "env",
      overrides: ["project", "global", "default"],
    });
    expect(await store.read({ key: "browser.relay", folder: project })).toMatchObject({
      value: true,
      source: "env",
      overrides: ["global", "default"],
    });
    expect(await store.read({ key: "browser.cmux", folder: project })).toMatchObject({
      value: false,
      source: "env",
      overrides: ["global", "default"],
    });
    expect(await store.read({ key: "browser.tern", folder: project })).toMatchObject({
      value: false,
      source: "env",
      overrides: ["project", "global", "default"],
    });
    store.dispose();
  });

  test("a saved edit is written to the file, and the environment keeps winning", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await mkdir(agent, { recursive: true });
    await writeText(join(agent, "config.yml"), "dev:\n  autoqa: false\n");
    const store = new ConfigStoreService({
      agentDir: agent,
      appDataDir: join(root, "app"),
      environmentValues: () =>
        ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA: "0" } })),
    });
    const revision = (await store.list({ folder: null })).revision;

    const written = await store.write({
      key: "dev.autoqa",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: false, value: true },
    });

    expect(written.entry).toMatchObject({ key: "dev.autoqa", value: false, source: "env" });
    expect(await store.read({ key: "dev.autoqa", folder: null })).toMatchObject({
      value: false,
      source: "env",
      overrides: ["global"],
    });
    expect(await readFile(join(agent, "config.yml"), "utf8")).toContain("autoqa: true");
    store.dispose();
  });

  test("an environment value names the variable that sets it, and a saved value names none", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await writeText(join(agent, "config.yml"), "tools:\n  intentTracing: true\n");
    const store = new ConfigStoreService({
      agentDir: agent,
      appDataDir: join(root, "app"),
      environmentValues: () =>
        ompEnvironmentValues(
          sourcesIn(root, {
            processEnv: { PI_AUTO_QA: "0", PI_AUTO_QA_PUSH_URL: "https://env.example.test/v1" },
          }),
        ),
      environmentVariables: ompEnvironmentVariableNames,
    });
    expect(await store.read({ key: "dev.autoqa", folder: null })).toMatchObject({
      source: "env",
      overriddenBy: "PI_AUTO_QA",
    });
    expect(await store.read({ key: "dev.autoqaPush.endpoint", folder: null })).toMatchObject({
      secret: false,
      source: "env",
      overriddenBy: "PI_AUTO_QA_PUSH_URL",
    });
    const saved = await store.read({ key: "tools.intentTracing", folder: null });
    expect(saved).toMatchObject({ source: "global" });
    expect(saved).not.toHaveProperty("overriddenBy");
    store.dispose();
  });

  test("the push token from the environment is a secret: its status is set and its value never leaves the server", async () => {
    const root = await temporaryRoot();
    const store = new ConfigStoreService({
      agentDir: join(root, "agent"),
      appDataDir: join(root, "app"),
      environmentValues: () =>
        ompEnvironmentValues(sourcesIn(root, { processEnv: { PI_AUTO_QA_PUSH_TOKEN: TOKEN } })),
    });
    expect(await store.read({ key: "dev.autoqaPush.token", folder: null })).toMatchObject({
      key: "dev.autoqaPush.token",
      secret: true,
      isSet: true,
      source: "env",
    });
    expect(JSON.stringify(await store.list({ folder: null }))).not.toContain(TOKEN);
    store.dispose();
  });

  test("a saved endpoint whose query carries a credential is hidden, and a plain endpoint can replace it", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await writeText(
      join(agent, "config.yml"),
      `dev:\n  autoqaPush:\n    endpoint: https://qa.example.test/v1?token=${TOKEN}\n`,
    );
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const saved = await store.read({ key: "dev.autoqaPush.endpoint", folder: null });
    expect(saved).toMatchObject({ secret: true, isSet: true, source: "global" });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(await store.list({ folder: null }))).not.toContain(TOKEN);

    const revision = (await store.list({ folder: null })).revision;
    await store.write({
      key: "dev.autoqaPush.endpoint",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: false, value: "https://qa.example.test/v1" },
    });
    expect(await store.read({ key: "dev.autoqaPush.endpoint", folder: null })).toMatchObject({
      secret: false,
      value: "https://qa.example.test/v1",
    });
    store.dispose();
  });

  test("a browser URL with a credential is hidden like the push endpoint, and a plain one is shown", async () => {
    const root = await temporaryRoot();
    const agent = join(root, "agent");
    await writeText(
      join(agent, "config.yml"),
      `browser:\n  cdpUrl: ${JSON.stringify(`https://127.0.0.1:9222/?token=${TOKEN}`)}\n  relayUrl: http://127.0.0.1:9224\n`,
    );
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const cdp = await store.read({ key: "browser.cdpUrl", folder: null });
    expect(cdp).toMatchObject({ secret: true, isSet: true, source: "global" });
    expect(JSON.stringify(cdp)).not.toContain(TOKEN);
    expect(JSON.stringify(await store.list({ folder: null }))).not.toContain(TOKEN);
    expect(await store.read({ key: "browser.relayUrl", folder: null })).toMatchObject({
      secret: false,
      value: "http://127.0.0.1:9224",
    });
    store.dispose();
  });
});
