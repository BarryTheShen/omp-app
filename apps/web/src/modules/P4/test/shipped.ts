import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** A shipped P4 source file: its path under the P4 folder, and its text. */
export interface ShippedSource {
  readonly path: string;
  readonly text: string;
}

/** The P4 folder. Vitest runs from the web app (`apps/web`), as the repository's source-scan tests assume. */
function p4Folder(): string {
  const fromWeb = join(process.cwd(), "src/modules/P4");
  return existsSync(fromWeb) ? fromWeb : join(process.cwd(), "apps/web/src/modules/P4");
}

/** The absolute paths of P4's shipped sources: no tests, fixtures, the test folder or playgrounds. */
function shippedPaths(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "test" && entry !== "fixtures") shippedPaths(full, out);
    } else if (
      /\.tsx?$/.test(entry) &&
      !/\.test\.tsx?$/.test(entry) &&
      !/playground|fixture/.test(entry)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** P4's shipped sources, each with its path under the P4 folder and its text. */
export function shippedSources(): ShippedSource[] {
  const root = p4Folder();
  return shippedPaths(root).map((full) => ({
    path: relative(root, full),
    text: readFileSync(full, "utf8"),
  }));
}
