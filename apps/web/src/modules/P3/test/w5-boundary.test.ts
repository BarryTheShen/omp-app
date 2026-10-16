import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";

/** P3's folder. Vitest runs from apps/web, the same root the other source-scanning tests use. */
const MODULE_ROOT = resolve(process.cwd(), "src/modules/P3");
/** apps/web/src: the root every `@/` import resolves against. */
const SRC_ROOT = resolve(process.cwd(), "src");

/**
 * Production and playground sources: every .ts and .tsx file under P3 except tests and fixtures. A playground is a
 * dev page that only an e2e spec builds, so it is scanned like the rest, with the named exceptions below.
 */
function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" || entry.name === "fixtures" ? [] : productionFiles(path);
    }
    const isSource = /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name);
    return isSource ? [path] : [];
  });
}

const FILES = productionFiles(MODULE_ROOT);

/** The module specifiers a file imports or re-exports, including dynamic imports. */
function specifiersOf(source: string): string[] {
  const pattern = /(?:from\s+|import\s+|import\(\s*)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** `@/modules/<ID>/<rest>`: another module's file, named by its id and the path inside that module. */
const MODULE_IMPORT = /^@\/modules\/([A-Za-z0-9.]+)\/(.+)$/;

/**
 * The one named exception: P3.3's selector playground is a dev page that imports a U4 dialog internal. Its file and
 * specifier are listed, and nothing else in P3 may import that path.
 */
const NAMED_EXCEPTIONS: ReadonlyArray<{ readonly file: string; readonly specifier: string }> = [
  { file: "selector/playground.tsx", specifier: "@/modules/U4/dialogs/renderer" },
];

/** Whether `path` is `root` or a file or folder inside it. */
function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * A module path is reachable when it is a contract file, or a folder that has an index (its barrel). A single file
 * such as `T1/edit.tsx`, or a deep path into a folder, is not.
 */
function isBarrelOrContract(moduleId: string, rest: string): boolean {
  if (rest.startsWith("contract/")) return true;
  const folder = resolve(SRC_ROOT, "modules", moduleId, rest);
  return (
    existsSync(folder) &&
    statSync(folder).isDirectory() &&
    (existsSync(join(folder, "index.ts")) || existsSync(join(folder, "index.tsx")))
  );
}

/** The production files whose imports match `check`, as "file imports specifier" lines. */
function violationsOf(check: (file: string, specifier: string) => boolean): string[] {
  return FILES.flatMap((file) => {
    const relativeFile = relative(MODULE_ROOT, file).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    return specifiersOf(source)
      .filter(
        (specifier) =>
          !NAMED_EXCEPTIONS.some((ex) => ex.file === relativeFile && ex.specifier === specifier),
      )
      .filter((specifier) => check(file, specifier))
      .map((specifier) => `${relativeFile} imports ${specifier}`);
  });
}

describe("W5 boundary: P3 consumes typed ports only", () => {
  test("the scan reads P3's production sources, not an empty set", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  test("production code imports no omp module, no wire or RPC layer, and no server package", () => {
    const violations = violationsOf(
      (_file, specifier) =>
        /^@\/modules\/A0(\/|$)/.test(specifier) ||
        /omp-wire/.test(specifier) ||
        /omp-rpc/.test(specifier) ||
        /^@omp-app\/server/.test(specifier),
    );

    expect(violations).toEqual([]);
  });

  test("production code imports nothing from the app shell, the mount lists or the layout", () => {
    const violations = violationsOf((_file, specifier) =>
      /^@\/(app|registry|layout)(\/|$)/.test(specifier),
    );

    expect(violations).toEqual([]);
  });

  test("production code reaches another module only through its folder barrel or its contract files", () => {
    const violations = violationsOf((_file, specifier) => {
      const match = MODULE_IMPORT.exec(specifier);
      if (match === null) return false;
      const moduleId = match[1] ?? "";
      const rest = match[2] ?? "";
      if (moduleId === "P3") return false;
      return !isBarrelOrContract(moduleId, rest);
    });

    expect(violations).toEqual([]);
  });

  test("relative imports stay inside P3 or reach shared components and helpers, never another module", () => {
    const violations = violationsOf((file, specifier) => {
      if (!specifier.startsWith(".")) return false;
      const target = resolve(dirname(file), specifier);
      if (isInside(target, MODULE_ROOT)) return false;
      return isInside(target, join(SRC_ROOT, "modules")) || isInside(target, join(SRC_ROOT, "app"));
    });

    expect(violations).toEqual([]);
  });

  test("no production file imports a fixture or a test helper", () => {
    const violations = violationsOf(
      (_file, specifier) =>
        /(^|\/)fixtures(\/|$)/.test(specifier) ||
        /(^|\/)test(\/|$)/.test(specifier) ||
        /test-support$/.test(specifier),
    );

    expect(violations).toEqual([]);
  });

  test("nothing in production depends on the serving choice (web or desktop)", () => {
    const serving = /tauri|electron|__TAURI__|desktop|serving/i;
    const violations = FILES.filter((file) => serving.test(readFileSync(file, "utf8"))).map(
      (file) => relative(MODULE_ROOT, file),
    );

    expect(violations).toEqual([]);
  });

  test("every relative import in production names a file that exists", () => {
    const missing = FILES.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return specifiersOf(source)
        .filter((specifier) => specifier.startsWith("."))
        .filter((specifier) => {
          const base = resolve(dirname(file), specifier);
          return ![
            base,
            `${base}.ts`,
            `${base}.tsx`,
            join(base, "index.ts"),
            join(base, "index.tsx"),
          ].some((candidate) => existsSync(candidate));
        })
        .map((specifier) => `${relative(MODULE_ROOT, file)} imports ${specifier}`);
    });

    expect(missing).toEqual([]);
  });
});
