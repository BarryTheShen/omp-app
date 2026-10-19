import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppFailure } from "@omp-app/contracts";
import { ExtensionCatalogService } from "./store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-extensions-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function waitForWatchers(): Promise<void> {
  // Real fs.watch delivery and debounce are the integration under test.
  await Bun.sleep(260);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ExtensionCatalogService", () => {
  test("lists native extensions, plugins, skills, commands, project shadowing and broken manifests", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const agent = join(home, ".omp", "agent");
    const project = join(root, "project");
    const nativePackage = join(agent, "extensions", "native-ext", "package.json");
    await writeJson(nativePackage, {
      name: "native-ext",
      version: "1.2.3",
      description: "Native extension",
      omp: {
        extensions: ["index.ts"],
        commands: ["commands/native.ts"],
        tools: ["tools/index.ts"],
      },
    });
    await writeText(join(agent, "extensions", "native-ext", "index.ts"), "export default {};");
    await writeText(join(agent, "extensions", "broken", "package.json"), "{not-json");
    await writeText(
      join(agent, "skills", "docs", "SKILL.md"),
      "---\nname: docs\ndescription: Documentation helper\n---\nBody\n",
    );
    await writeText(join(agent, "skills", "broken", "SKILL.md"), "---\nname: broken\n---\nBody\n");

    const globalPluginRoot = join(home, ".omp", "plugins");
    await writeJson(join(globalPluginRoot, "package.json"), {
      dependencies: { "demo-plugin": "1.0.0", shadowed: "1.0.0" },
    });
    await writeJson(join(globalPluginRoot, "omp-plugins.lock.json"), {
      plugins: {
        "demo-plugin": { version: "1.0.0", enabled: true },
        shadowed: { version: "1.0.0", enabled: true },
      },
    });
    await writeJson(join(globalPluginRoot, "node_modules", "demo-plugin", "package.json"), {
      name: "demo-plugin",
      version: "1.0.0",
      description: "Demo plugin",
      omp: { extensions: ["index.js"], commands: ["commands/demo.ts"] },
    });
    await writeJson(join(globalPluginRoot, "node_modules", "shadowed", "package.json"), {
      name: "shadowed",
      version: "1.0.0",
      omp: { extensions: ["index.js"] },
    });

    await writeJson(join(project, ".omp", "plugins", "package.json"), {
      dependencies: { shadowed: "2.0.0" },
    });
    await writeJson(join(project, ".omp", "plugins", "omp-plugins.lock.json"), {
      plugins: { shadowed: { version: "2.0.0", enabled: false } },
    });
    await writeJson(join(project, ".omp", "plugins", "node_modules", "shadowed", "package.json"), {
      name: "shadowed",
      version: "2.0.0",
      omp: { extensions: ["index.js"] },
    });
    await writeJson(join(globalPluginRoot, "installed_plugins.json"), {
      version: 2,
      plugins: {
        "demo@community": [
          {
            scope: "user",
            installPath: join(globalPluginRoot, "node_modules", "demo-plugin"),
            version: "1.0.0",
            installedAt: "2026-10-18T00:00:00.000Z",
            lastUpdated: "2026-10-18T00:00:00.000Z",
            enabled: false,
          },
        ],
      },
    });

    const catalog = new ExtensionCatalogService({ homeDir: home, env: { HOME: home } });
    const global = await catalog.list({ folder: null });
    expect(global.extensions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["native-ext", "demo-plugin", "docs", "broken"]),
    );
    const native = global.extensions.find((entry) => entry.id === "native-ext");
    expect(native).toMatchObject({
      source: "extension",
      version: "1.2.3",
      enabled: true,
      description: "Native extension",
    });
    expect(native?.path.startsWith("/")).toBe(false);
    expect(native?.path.includes("..")).toBe(false);
    expect(global.extensions.find((entry) => entry.id === "demo-plugin")).toMatchObject({
      marketplacePluginId: "demo@community",
      marketplaceScope: "user",
      enabled: false,
    });
    const broken = global.extensions.find((entry) => entry.id === "broken");
    expect(broken?.error).toBe("Malformed JSON manifest.");
    expect(global.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "native", provider: "native" }),
        expect.objectContaining({ name: "demo", provider: "demo-plugin" }),
      ]),
    );

    const projectResult = await catalog.list({ folder: project });
    const shadows = projectResult.extensions.filter((entry) => entry.id === "shadowed");
    expect(shadows).toHaveLength(2);
    expect(shadows.find((entry) => entry.version === "1.0.0")?.shadowed).toBe(true);
    expect(shadows.find((entry) => entry.version === "2.0.0")).toMatchObject({
      shadowed: false,
      enabled: false,
    });
    catalog.dispose();
  });

  test("reloads and emits one filesystem event, while reload and omp invalidations carry reasons", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const skillPath = join(home, ".omp", "agent", "skills", "docs", "SKILL.md");
    await writeText(skillPath, "---\nname: docs\ndescription: First description\n---\nBody\n");
    let reloadCalls = 0;
    const catalog = new ExtensionCatalogService({
      homeDir: home,
      env: { HOME: home },
      reload: () => {
        reloadCalls += 1;
      },
    });
    const events: { reason: string; revision: string }[] = [];
    const unsubscribe = catalog.subscribe(null, (event) => {
      events.push(event);
    });
    await waitForWatchers();

    await writeText(skillPath, "---\nname: docs\ndescription: Updated description\n---\nBody\n");
    await waitForWatchers();
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("filesystem");

    const reloaded = await catalog.reload({ folder: null });
    expect(reloaded.extensions.find((entry) => entry.id === "docs")?.description).toBe(
      "Updated description",
    );
    expect(reloadCalls).toBe(1);
    expect(events.at(-1)?.reason).toBe("reload");

    await catalog.notifyOmpChanged(null);
    expect(events.at(-1)?.reason).toBe("omp");
    unsubscribe();
    catalog.dispose();
  });

  test("does not create missing discovery roots and tolerates an empty catalog", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const catalog = new ExtensionCatalogService({ homeDir: home, env: { HOME: home } });
    const result = await catalog.list({ folder: null });
    expect(result.extensions).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(await Bun.file(join(home, ".omp", "agent")).exists()).toBe(false);
    catalog.dispose();
  });

  test("an unreadable extensions folder fails with the catalog's plain sentence, and keeps the cause", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const extensions = join(home, ".omp", "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await chmod(extensions, 0o000);
    const catalog = new ExtensionCatalogService({ homeDir: home, env: { HOME: home } });
    try {
      const failure = await catalog.list({ folder: null }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AppFailure);
      if (!(failure instanceof AppFailure)) throw new Error("expected an AppFailure");
      expect(failure.appError).toEqual({
        code: "permission",
        message: "Unable to read the installed extensions.",
        retryable: true,
      });
      expect(failure.cause).toMatchObject({ code: "EACCES" });
    } finally {
      catalog.dispose();
      await chmod(extensions, 0o755);
    }
  });

  test("a readable extensions folder whose child cannot be checked fails with the catalog's sentence too", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const extensions = join(home, ".omp", "agent", "extensions");
    await writeText(join(extensions, "native-ext", "index.ts"), "export default {};");
    // Listing needs only read permission, but checking a child needs search permission too.
    await chmod(extensions, 0o444);
    const catalog = new ExtensionCatalogService({ homeDir: home, env: { HOME: home } });
    try {
      const failure = await catalog.list({ folder: null }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AppFailure);
      if (!(failure instanceof AppFailure)) throw new Error("expected an AppFailure");
      expect(failure.appError).toEqual({
        code: "permission",
        message: "Unable to read the installed extensions.",
        retryable: true,
      });
      expect(failure.cause).toMatchObject({ code: "EACCES" });
    } finally {
      catalog.dispose();
      await chmod(extensions, 0o755);
    }
  });
});
