import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppFailure } from "@omp-app/contracts";
import { ConfigStoreService } from "./config-store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function waitForWatchers(): Promise<void> {
  // This deliberately exercises real fs.watch delivery and atomic rename debounce.
  await Bun.sleep(260);
}
async function appFailure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
    throw new Error("Expected an AppFailure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    return error as AppFailure;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ConfigStoreService", () => {
  test("resolves global, project, and app layers with provenance and lower-layer overrides", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const agent = join(root, "agent");
    const app = join(root, "app");
    await mkdir(project, { recursive: true });
    await writeText(
      join(agent, "config.yml"),
      "compaction:\n  enabled: false\n  threshold: 80\nmodel: global-model\n",
    );
    await writeText(
      join(project, ".omp", "config.yml"),
      "compaction:\n  enabled: true\nmodel: project-model\n",
    );
    await writeText(join(app, "config.yml"), "theme: dark\n");

    const store = new ConfigStoreService({ agentDir: agent, appDataDir: app });
    const enabled = await store.read({ key: "compaction.enabled", folder: project });
    expect(enabled).toMatchObject({
      key: "compaction.enabled",
      secret: false,
      value: true,
      source: "project",
      overrides: ["global"],
    });
    expect(enabled.provenance?.origin).toBe("omp-config");
    expect(enabled.provenance?.path).toBe(join(project, ".omp", "config.yml"));

    const globalOnly = await store.read({ key: "compaction.threshold", folder: project });
    expect(globalOnly).toMatchObject({ source: "global", overrides: [] });
    const appValue = await store.read({ key: "theme", folder: null });
    expect(appValue).toMatchObject({ source: "app", overrides: [] });
    const listed = await store.list({ folder: project });
    expect(listed.entries.map((entry) => entry.key)).toContain("model");
    expect(listed.entries.map((entry) => entry.key)).toContain("theme");
    store.dispose();
  });
  test("uses the global config.yaml fallback and never creates a project .omp folder for read or watch", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeText(join(agent, "config.yaml"), "model: fallback\n");
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    expect(await store.read({ key: "model", folder: project })).toMatchObject({
      value: "fallback",
      source: "global",
    });
    const unsubscribe = store.subscribe(project, () => {});
    await waitForWatchers();
    expect(await Bun.file(join(project, ".omp")).exists()).toBe(false);
    unsubscribe();
    store.dispose();
  });
  test("writes the canonical config.yml while reading config.yaml as the fallback", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    const fallbackPath = join(agent, "config.yaml");
    const canonicalPath = join(agent, "config.yml");
    await writeText(fallbackPath, "# fallback comment\nmodel: old\n");
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const revision = (await store.list({ folder: null })).revision;
    await store.write({
      key: "model",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: false, value: "new" },
    });
    expect(await Bun.file(canonicalPath).exists()).toBe(true);
    expect(await readFile(canonicalPath, "utf8")).toContain("# fallback comment");
    const read = await store.read({ key: "model", folder: null });
    expect(read).toMatchObject({ secret: false, value: "new" });
    store.dispose();
  });
  test("resolves the injected omp profile and app-data environment paths", () => {
    const root = "/config-store-home";
    const store = new ConfigStoreService({
      homeDir: root,
      env: { OMP_PROFILE: "work", OMP_APP_DATA_DIR: "~/app-data" },
    });
    expect(store.agentDir).toBe(join(root, ".omp", "profiles", "work", "agent"));
    expect(store.appDataDir).toBe(join(root, "app-data"));
    store.dispose();
  });

  test("reports runtime and environment precedence while retaining lower configured layers", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    await writeText(join(agent, "config.yml"), "model: global\n");
    const store = new ConfigStoreService({
      agentDir: agent,
      environmentValues: { model: "environment" },
      runtimeValues: { thinking: "runtime" },
    });
    expect(await store.read({ key: "model", folder: null })).toMatchObject({
      source: "env",
      overrides: ["global"],
    });
    expect(await store.read({ key: "thinking", folder: null })).toMatchObject({
      source: "runtime",
    });
    store.dispose();
  });

  test("redacts credential-like values in reads, lists, writes, and events", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    const app = join(root, "app");
    await writeText(join(agent, "config.yml"), "provider:\n  apiKey: first-secret\n  name: demo\n");
    const changes: unknown[] = [];
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: app });
    const unsubscribe = store.subscribe(null, (change) => {
      changes.push(change);
    });
    await waitForWatchers();

    const read = await store.read({ key: "provider.apiKey", folder: null });
    expect(read).toMatchObject({ secret: true, isSet: true, source: "global" });
    expect(JSON.stringify(read)).not.toContain("first-secret");
    const parent = await store.read({ key: "provider", folder: null });
    expect(JSON.stringify(parent)).not.toContain("first-secret");

    const revision = (await store.list({ folder: null })).revision;
    const writeResult = await store.write({
      key: "provider.apiKey",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: true, action: "set", value: "second-secret" },
    });
    expect(JSON.stringify(writeResult)).not.toContain("second-secret");
    expect(changes).toHaveLength(0);

    await writeText(
      join(agent, "config.yml"),
      "provider:\n  apiKey: external-secret\n  name: demo\n",
    );
    await waitForWatchers();
    expect(changes).toHaveLength(1);
    expect(JSON.stringify(changes[0])).not.toContain("external-secret");
    unsubscribe();
    store.dispose();
  });

  test("treats credential-shaped values and header maps as secrets whatever the key", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    // Fake credentials are assembled at runtime so no source line looks like a real secret (the PR
    // gate rejects those); the store must still recognise the assembled values.
    const bearer = ["Bearer", "t".repeat(32)].join(" ");
    const apiKey = ["sk", "ant", "k".repeat(30)].join("-");
    const password = "p".repeat(14);
    await writeText(
      join(agent, "config.yml"),
      [
        "providers:",
        "  custom:",
        "    baseUrl: https://example.test/v1",
        "    headers:",
        `      Authorization: ${bearer}`,
        `    extra: ${apiKey}`,
        `    mirror: https://user:${password}@mirror.example.test/v1`,
        "",
      ].join("\n"),
    );
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const listed = JSON.stringify(await store.list({ folder: null }));
    for (const leaked of ["t".repeat(32), apiKey, password]) {
      expect(listed).not.toContain(leaked);
    }
    for (const key of [
      "providers.custom.headers.Authorization",
      "providers.custom.extra",
      "providers.custom.mirror",
    ]) {
      expect(await store.read({ key, folder: null })).toMatchObject({ secret: true, isSet: true });
    }
    expect(await store.read({ key: "providers.custom.baseUrl", folder: null })).toMatchObject({
      secret: false,
      value: "https://example.test/v1",
    });

    // A value shown as secret can only be set or unset, so the UI can never write a placeholder back.
    const revision = (await store.list({ folder: null })).revision;
    const plainWrite = await appFailure(
      store.write({
        key: "providers.custom.extra",
        layer: "global",
        folder: null,
        expectedRevision: revision,
        value: { secret: false, value: "replaced" },
      }),
    );
    expect(plainWrite.appError.code).toBe("invalid_args");
    await store.write({
      key: "providers.custom.extra",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: true, action: "unset" },
    });
    store.dispose();
  });

  test("patches one YAML key atomically while keeping comments and unrelated keys", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    const configPath = join(agent, "config.yml");
    await writeText(configPath, "# keep this comment\nfirst: one\nsecond: two\n");
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const revision = (await store.list({ folder: null })).revision;
    await store.write({
      key: "first",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: false, value: "changed" },
    });
    const content = await readFile(configPath, "utf8");
    expect(content).toContain("# keep this comment");
    expect(content).toContain("first: changed");
    expect(content).toContain("second: two");
    expect(content.indexOf("first:")).toBeLessThan(content.indexOf("second:"));
    store.dispose();
  });

  test("rejects a compare-and-swap write after an external edit", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    const configPath = join(agent, "config.yml");
    await writeText(configPath, "model: old\n");
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const revision = (await store.list({ folder: null })).revision;
    await writeFile(configPath, "model: external\n", "utf8");
    const error = await appFailure(
      store.write({
        key: "model",
        layer: "global",
        folder: null,
        expectedRevision: revision,
        value: { secret: false, value: "new" },
      }),
    );
    expect(error.appError.code).toBe("conflict");
    store.dispose();
  });

  test("requires an existing project folder for project writes and reports malformed YAML as AppFailure", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const missingFolder = join(root, "missing");
    const missingFolderError = await appFailure(
      store.write({
        key: "model",
        layer: "project",
        folder: missingFolder,
        expectedRevision: null,
        value: { secret: false, value: "x" },
      }),
    );
    expect(missingFolderError.appError.code).toBe("not_found");

    await mkdir(join(root, "project"), { recursive: true });
    await writeText(join(agent, "config.yml"), "model: [unterminated\n");
    const malformed = await appFailure(store.list({ folder: null }));
    expect(malformed.appError.code).toBe("invalid_args");
    store.dispose();
  });

  test("emits one external change and suppresses its own atomic write", async () => {
    const root = await temporaryDirectory();
    const agent = join(root, "agent");
    const configPath = join(agent, "config.yml");
    await writeText(configPath, "model: old\n");
    const events: ConfigChangedLike[] = [];
    const store = new ConfigStoreService({ agentDir: agent, appDataDir: join(root, "app") });
    const unsubscribe = store.subscribe(null, (change) => {
      events.push(change);
    });
    await waitForWatchers();
    const revision = (await store.list({ folder: null })).revision;
    await store.write({
      key: "model",
      layer: "global",
      folder: null,
      expectedRevision: revision,
      value: { secret: false, value: "own" },
    });
    await waitForWatchers();
    expect(events).toHaveLength(0);
    await writeFile(configPath, "model: external\n", "utf8");
    await waitForWatchers();
    expect(events).toHaveLength(1);
    expect(events[0]?.key).toBe("model");
    unsubscribe();
    store.dispose();
  });
});

type ConfigChangedLike = { readonly key: string };
