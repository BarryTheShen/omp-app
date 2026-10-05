import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppFailure, FolderPath, RuleName } from "@omp-app/contracts";
import { RuleStoreService } from "./rule-store";

const DATA_ROOT = resolve(import.meta.dir, "../../../../../../.data");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  await mkdir(DATA_ROOT, { recursive: true });
  const directory = await mkdtemp(join(DATA_ROOT, "rule-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForWatchers(): Promise<void> {
  // Real fs.watch delivery and atomic rename debounce are the integration under test.
  await Bun.sleep(220);
}

async function expectAppFailure(promise: Promise<unknown>): Promise<AppFailure> {
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

describe("RuleStoreService", () => {
  test("discovers global rulebooks, sticky RULES.md, and project rules in separate scopes", async () => {
    const home = await temporaryDirectory();
    const project = await temporaryDirectory();
    const agentRules = join(home, ".omp", "agent", "rules");
    const projectRules = join(project, ".omp", "rules");
    await mkdir(agentRules, { recursive: true });
    await mkdir(projectRules, { recursive: true });
    await writeFile(join(agentRules, "alpha.md"), "# Alpha\n\nGlobal rule", "utf8");
    await writeFile(
      join(home, ".omp", "agent", "RULES.md"),
      "---\nenabled: false\n---\nSticky",
      "utf8",
    );
    await writeFile(join(projectRules, "beta.mdc"), "Project rule", "utf8");

    const store = new RuleStoreService({ homeDir: home, env: {} });
    const global = await store.list({ scope: "global", folder: null });
    const projectRulesResult = await store.list({
      scope: "project",
      folder: FolderPath.parse(project),
    });

    expect(global.rules.map((rule) => rule.id)).toEqual(["RULES.md", "alpha.md"]);
    expect(global.rules.find((rule) => rule.id === "RULES.md")).toMatchObject({
      name: "RULES",
      scope: "global",
      source: "agent",
      enabled: true,
      content: "Sticky",
    });
    expect(global.rules.find((rule) => rule.id === "alpha.md")).toMatchObject({
      name: "alpha",
      content: "# Alpha\n\nGlobal rule",
      enabled: true,
    });
    expect(projectRulesResult.rules).toHaveLength(1);
    expect(projectRulesResult.rules[0]).toMatchObject({
      id: "beta.mdc",
      name: "beta",
      scope: "project",
      source: "project",
      content: "Project rule",
    });
  });

  test("writes with CAS, preserves frontmatter, and rejects stale revisions", async () => {
    const home = await temporaryDirectory();
    const rules = join(home, ".omp", "agent", "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(join(rules, "alpha.md"), "---\nglobs: '**/*.ts'\n---\nold body", "utf8");
    const store = new RuleStoreService({ homeDir: home, env: {} });
    const before = await store.list({ scope: "global", folder: null });
    const written = await store.write({
      scope: "global",
      folder: null,
      id: RuleName.parse("alpha.md"),
      content: "new body",
      enabled: false,
      expectedRevision: before.revision,
    });

    expect(written.previousRevision).toBe(before.revision);
    expect(written.rule).toMatchObject({ id: "alpha.md", content: "new body", enabled: false });
    const raw = await readFile(join(rules, "alpha.md"), "utf8");
    expect(raw).toContain("globs: '**/*.ts'");
    expect(raw).toContain("enabled: false");
    expect(raw).toContain("new body");

    const stale = await expectAppFailure(
      store.write({
        scope: "global",
        folder: null,
        id: RuleName.parse("alpha.md"),
        content: "stale",
        enabled: true,
        expectedRevision: before.revision,
      }),
    );
    expect(stale.appError).toMatchObject({ code: "conflict", retryable: true });
    expect(await readFile(join(rules, "alpha.md"), "utf8")).toBe(raw);
  });

  test("deletes through the scoped rule folder and rejects traversal names", async () => {
    const home = await temporaryDirectory();
    const rules = join(home, ".omp", "agent", "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(join(rules, "remove.md"), "remove me", "utf8");
    const store = new RuleStoreService({ homeDir: home, env: {} });
    const before = await store.list({ scope: "global", folder: null });
    const deleted = await store.delete({
      scope: "global",
      folder: null,
      id: RuleName.parse("remove.md"),
      expectedRevision: before.revision,
    });
    expect(deleted.deleted).toBe(true);
    await expect(readFile(join(rules, "remove.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const traversal = await expectAppFailure(
      store.read({ scope: "global", folder: null, id: "../outside.md" as never }),
    );
    expect(traversal.appError.code).toBe("invalid_args");
  });

  test("surfaces malformed frontmatter without overwriting it", async () => {
    const home = await temporaryDirectory();
    const rules = join(home, ".omp", "agent", "rules");
    await mkdir(rules, { recursive: true });
    const malformed = "---\nenabled: [\n---\nbody";
    const path = join(rules, "broken.md");
    await writeFile(path, malformed, "utf8");
    const store = new RuleStoreService({ homeDir: home, env: {} });

    const error = await expectAppFailure(store.list({ scope: "global", folder: null }));
    expect(error.appError.code).toBe("invalid_args");
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  test("publishes external changes and stops after unsubscribe", async () => {
    const home = await temporaryDirectory();
    const rules = join(home, ".omp", "agent", "rules");
    const path = join(rules, "live.md");
    await mkdir(rules, { recursive: true });
    await writeFile(path, "first", "utf8");
    const store = new RuleStoreService({ homeDir: home, env: {}, watchDebounceMs: 20 });
    const changes: unknown[] = [];
    const unsubscribe = store.subscribe({ scope: "global", folder: null }, (change) => {
      changes.push(change);
    });
    await waitForWatchers();
    await writeFile(path, "second", "utf8");
    await waitForWatchers();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: "live.md", scope: "global", reason: "filesystem" });
    unsubscribe();
    await writeFile(path, "third", "utf8");
    await waitForWatchers();
    expect(changes).toHaveLength(1);
    store.dispose();
  });
});
